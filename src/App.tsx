import { CSSProperties, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { imageReferrerPolicy, minifluxReferrerScope, updateOriginReferrerFeeds } from "./article-images";
import { runExclusive } from "./async-lock";
import { loadOptionalMinifluxTimeZone } from "./miniflux-timezone.mjs";
import { compareSmartFeedEntries, countSmartFeedEntries, formatZonedDateTime, formatZonedTime, isEntryInSmartFeed, localDayKey, nextDayBoundary, selectTimeZone, toZonedDateTimeInput, zonedDateTimeInputToIso } from "./smart-feeds.mjs";
import {
  clearConnection,
  ConnectionConfig,
  deleteReadingEvent,
  EntrySyncPhase,
  getCachedEntries,
  getConnection,
  getEntrySyncState,
  getProfileSettings,
  getReadingEvents,
  minifluxFetch,
  newReadingEvent,
  normalizeReadingEventOpenedAt,
  putCachedEntries,
  ProfileSettings,
  putReadingEvent,
  ReadingEvent,
  resetEntrySync,
  saveConnection,
  saveEntrySyncState,
  saveProfileSettings,
  ThemeName,
} from "./readflux-client";

type Feed = {
  id: number;
  title: string;
  category?: { id: number; title: string };
  icon?: { feed_id: number; icon_id: number } | null;
};
type Category = { id: number; title: string };
type FeedIcon = { id: number; data: string; mime_type: string };
type MinifluxUser = { timezone?: string };
type Entry = {
  id: number;
  feed_id: number;
  status: "read" | "unread" | "removed";
  title: string;
  url: string;
  content: string;
  author?: string;
  published_at: string;
  starred: boolean;
  reading_time?: number;
  tags?: string[];
  feed?: Feed;
};
type Story = Entry & {
  source: string;
  category: string;
  categoryId?: number;
  mark: string;
  summary: string;
  score: number;
  reason: string;
};
type EntryPage = { total: number; entries: Entry[] };
type ListMode = "today" | "unread" | "saved";
type Topic = { kind: "category" | "feed"; id: number } | null;
type SyncProgress = {
  kind: "initial" | "incremental" | "search";
  phase?: EntrySyncPhase;
  loaded: number;
  total: number;
};

const ENTRY_PAGE_SIZE = 100;
const DEFAULT_LOOKBACK_DAYS = 30;
const LOOKBACK_OPTIONS = [
  { value: 7, label: "最近 7 天" },
  { value: 30, label: "最近 30 天" },
  { value: 90, label: "最近 90 天" },
  { value: 365, label: "最近 1 年" },
  { value: null, label: "全部文章" },
] as const;

function readStoredBoolean(key: string) {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

const toText = (html: string) => html
  .replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&#39;/g, "'")
  .replace(/&quot;/g, "\"")
  .replace(/\s+/g, " ")
  .trim();

const termsOf = (value: string) => value
  .toLowerCase()
  .split(/[^\p{L}\p{N}+#-]+/u)
  .filter((word) => word.length > 2)
  .slice(0, 80);

async function loadEntryPages(
  config: ConnectionConfig,
  filters: Record<string, string>,
  onPage: (entries: Entry[], loaded: number, total: number, nextOffset: number) => Promise<void>,
  startOffset = 0,
) {
  let offset = startOffset;
  let total = Number.POSITIVE_INFINITY;

  while (offset < total) {
    const params = new URLSearchParams({
      limit: String(ENTRY_PAGE_SIZE),
      offset: String(offset),
      order: "published_at",
      direction: "desc",
      ...filters,
    });
    const page = await minifluxFetch<EntryPage>(config, `/v1/entries?${params}`);
    const batch = page.entries ?? [];
    total = page.total ?? offset + batch.length;
    const nextOffset = offset + batch.length;
    await onPage(batch, Math.min(nextOffset, total), total, nextOffset);
    if (!batch.length || nextOffset >= total) break;
    offset = nextOffset;
  }

}

function safeHtml(html: string, useOriginReferrer = false) {
  if (typeof window === "undefined") return "";
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script,style,iframe,object,embed,form,video,audio,source").forEach((node) => node.remove());
  parsed.querySelectorAll("*").forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      if (attribute.name.startsWith("on") || attribute.name === "style" || attribute.name === "srcdoc") {
        node.removeAttribute(attribute.name);
      }
    });
  });
  parsed.querySelectorAll("a").forEach((link) => {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  });
  parsed.querySelectorAll("img").forEach((image) => {
    const src = image.getAttribute("src") ?? "";
    if (!/^https?:\/\//i.test(src)) image.remove();
    else {
      image.setAttribute("loading", "lazy");
      image.setAttribute("referrerpolicy", imageReferrerPolicy(useOriginReferrer));
    }
  });
  return parsed.body.innerHTML;
}

const SourceIcon = ({ children, src }: { children: React.ReactNode; src?: string }) => (
  <span className={`sourceIcon ${src ? "hasImage" : ""}`}>
    {src ? <img src={src} alt="" /> : children}
  </span>
);

const THEME_OPTIONS: { id: ThemeName; title: string; hint: string }[] = [
  { id: "day", title: "白天", hint: "明亮、清晰，适合日间连续阅读" },
  { id: "night", title: "夜晚", hint: "低亮度深色，适合夜间阅读" },
];

type EventDraft = Omit<ReadingEvent, "id" | "updatedAt"> & { id?: string };

function emptyEventDraft(): EventDraft {
  return {
    entryId: 0,
    feedId: 0,
    title: "",
    source: "",
    terms: [],
    openedAt: new Date().toISOString(),
    activeSeconds: 30,
    scrollDepth: 0.5,
    origin: "feed",
  };
}

function SettingsDialog({
  config,
  feeds,
  referrerScope,
  events,
  settings,
  timeZone,
  timeZoneSource,
  sourceWeights,
  wordWeights,
  negativeWeights,
  starredCount,
  onClose,
  onSettingsChange,
  onEventsChange,
  onDisconnect,
  onResetSync,
  syncBusy,
  notify,
}: {
  config: ConnectionConfig;
  feeds: Feed[];
  referrerScope: string;
  events: ReadingEvent[];
  settings: ProfileSettings;
  timeZone: string;
  timeZoneSource: "miniflux" | "browser";
  sourceWeights: Map<number, number>;
  wordWeights: Map<string, number>;
  negativeWeights: Map<string, number>;
  starredCount: number;
  onClose: () => void;
  onSettingsChange: (settings: ProfileSettings) => void;
  onEventsChange: (events: ReadingEvent[]) => void;
  onDisconnect: () => void;
  onResetSync: () => Promise<void>;
  syncBusy: boolean;
  notify: (message: string) => void;
}) {
  const [tab, setTab] = useState<"general" | "sync" | "recommendation">("general");
  const [resetting, setResetting] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [eventQuery, setEventQuery] = useState("");
  const [draft, setDraft] = useState<EventDraft | null>(null);
  const profileWriteInFlight = useRef(false);
  const currentSettings = useRef(settings);

  useEffect(() => { currentSettings.current = settings; }, [settings]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  const saveProfileChange = async (change: (current: ProfileSettings) => ProfileSettings, failure: string) => {
    try {
      const result = await runExclusive(profileWriteInFlight, async () => {
        setProfileSaving(true);
        try {
          const next = change(currentSettings.current);
          await saveProfileSettings(next);
          currentSettings.current = next;
          onSettingsChange(next);
        } finally {
          setProfileSaving(false);
        }
      });
      if (!result.started) notify("设置正在保存，请稍候");
      return result.started;
    } catch {
      notify(failure);
      return false;
    }
  };

  const setTheme = async (theme: ThemeName) => {
    await saveProfileChange(
      (current) => ({ ...current, theme, updatedAt: new Date().toISOString() }),
      "主题设置保存失败",
    );
  };

  const setOriginReferrerFeed = async (feedId: number, useOrigin: boolean) => {
    if (!referrerScope) return;
    await saveProfileChange((current) => ({
      ...current,
      originReferrerFeeds: updateOriginReferrerFeeds(
        current.originReferrerFeeds ?? {},
        referrerScope,
        feedId,
        useOrigin,
      ),
    }), "图片来源设置保存失败");
  };

  const setEntryLookback = async (value: string) => {
    const entryLookbackDays = value === "all" ? null : Number(value);
    const saved = await saveProfileChange(
      (current) => ({ ...current, entryLookbackDays, updatedAt: new Date().toISOString() }),
      "文章加载范围保存失败",
    );
    if (saved) notify(entryLookbackDays === null ? "将同步全部文章，收藏始终不受限制" : `将同步最近 ${entryLookbackDays} 天，收藏始终不受限制`);
  };

  const resetSync = async () => {
    if (!window.confirm("清除当前 Miniflux 连接的文章缓存和同步进度，并重新执行首次加载？阅读画像和连接凭据会保留。")) return;
    setResetting(true);
    try {
      await onResetSync();
    } finally {
      setResetting(false);
    }
  };

  const saveEvent = async () => {
    if (!draft || !draft.title.trim() || !draft.source.trim()) {
      notify("请填写文章标题和来源");
      return;
    }
    const openedAt = normalizeReadingEventOpenedAt(draft.openedAt);
    if (!openedAt) {
      notify("请选择有效的打开时间");
      return;
    }
    const now = new Date().toISOString();
    const event: ReadingEvent = {
      ...draft,
      id: draft.id ?? crypto.randomUUID(),
      title: draft.title.trim(),
      source: draft.source.trim(),
      terms: draft.terms.map((term) => term.trim().toLowerCase()).filter(Boolean),
      openedAt,
      activeSeconds: Math.max(0, Number(draft.activeSeconds) || 0),
      scrollDepth: Math.max(0, Math.min(1, Number(draft.scrollDepth) || 0)),
      updatedAt: now,
    };
    await putReadingEvent(event);
    onEventsChange(draft.id
      ? events.map((item) => item.id === event.id ? event : item)
      : [...events, event]);
    setDraft(null);
    notify(draft.id ? "阅读事件已更新" : "阅读事件已添加");
  };

  const removeEvent = async (event: ReadingEvent) => {
    if (!window.confirm(`删除「${event.title}」的这条阅读记录？`)) return;
    await deleteReadingEvent(event.id);
    onEventsChange(events.filter((item) => item.id !== event.id));
    if (draft?.id === event.id) setDraft(null);
    notify("阅读事件已删除");
  };

  const validEvents = events.filter((event) =>
    event.activeSeconds >= 6 || event.scrollDepth >= 0.15 || event.feedback === "helpful");
  const averageSeconds = events.length
    ? Math.round(events.reduce((sum, event) => sum + event.activeSeconds, 0) / events.length)
    : 0;
  const averageDepth = events.length
    ? Math.round(events.reduce((sum, event) => sum + event.scrollDepth, 0) / events.length * 100)
    : 0;
  const helpfulCount = events.filter((event) => event.feedback === "helpful").length;
  const negativeCount = events.filter((event) => event.feedback === "not_interested").length;
  const sourceName = new Map<number, string>();
  events.forEach((event) => sourceName.set(event.feedId, event.source));
  const topSources = [...sourceWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const topWords = [...wordWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const topNegatives = [...negativeWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const shownEvents = [...events]
    .filter((event) => !eventQuery.trim() || `${event.title} ${event.source} ${event.terms.join(" ")}`.toLowerCase().includes(eventQuery.trim().toLowerCase()))
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));

  return (
    <div className="settingsBackdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="settingsDialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header>
          <div><small>SIGNAL PREFERENCES</small><h2 id="settings-title">设置</h2></div>
          <button onClick={onClose} aria-label="关闭设置">×</button>
        </header>
        <nav className="settingsTabs" aria-label="设置分类">
          <button className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>通用</button>
          <button className={tab === "sync" ? "active" : ""} onClick={() => setTab("sync")}>同步</button>
          <button className={tab === "recommendation" ? "active" : ""} onClick={() => setTab("recommendation")}>推荐数据 <span>{events.length}</span></button>
        </nav>

        <div className="settingsDialogBody">
          {tab === "general" && <>
            <section>
              <div className="settingTitle"><div><h3>外观</h3><p>在白天与夜晚阅读模式之间切换。</p></div></div>
              <div className="themeGrid">
                {THEME_OPTIONS.map((option) => (
                  <button key={option.id} disabled={profileSaving} className={settings.theme === option.id ? "themeCard selected" : "themeCard"} onClick={() => void setTheme(option.id)}>
                    <i className={`themeSwatch ${option.id}`}><b /><b /><b /></i>
                    <strong>{option.title}</strong>
                    <small>{option.hint}</small>
                  </button>
                ))}
              </div>
            </section>
            <section>
              <div className="settingTitle"><div><h3>图片来源兼容性</h3><p>默认不发送来源信息。仅为无法显示图片的订阅源启用 Origin Referer。</p></div></div>
              <div className="originFeedList">
                {feeds.length && referrerScope ? [...feeds]
                  .sort((a, b) => `${a.category?.title ?? ""}\n${a.title}`.localeCompare(`${b.category?.title ?? ""}\n${b.title}`, "zh-CN"))
                  .map((feed) => <label key={feed.id}>
                    <input
                      type="checkbox"
                      checked={settings.originReferrerFeeds?.[referrerScope]?.includes(feed.id) ?? false}
                      disabled={profileSaving}
                      onChange={(event) => void setOriginReferrerFeed(feed.id, event.target.checked)}
                    />
                    <span><strong>{feed.title}</strong><small>{feed.category?.title ?? "未分组"}</small></span>
                  </label>)
                  : <p>{feeds.length ? "正在准备订阅源设置…" : "还没有可配置的订阅源。"}</p>}
              </div>
            </section>
            <section className="privacyBox">
              <strong>本地数据边界</strong>
              <p>“批量已读”只写回 Miniflux，不会成为兴趣信号。只有实际打开、前台停留、滚动深度、收藏和明确反馈会影响推荐。</p>
            </section>
          </>}

          {tab === "sync" && <>
            <section>
              <div className="settingTitle">
                <div><h3>Miniflux 同步</h3><p>管理文章加载范围、当前连接和本地同步数据。</p></div>
                <span>已连接</span>
              </div>
              <div className="settingsForm minifluxSettings">
                <label><span>服务器</span><input value={config.url} readOnly /></label>
                <label className="timeZoneSetting"><span>时区</span><input value={timeZone} readOnly /><small>{timeZoneSource === "miniflux" ? "来自 Miniflux 账户设置，应用于所有日期与时间。" : "Miniflux 时区不可用，所有日期与时间使用浏览器时区。"}</small></label>
                <label className="lookbackSetting">
                  <span>文章加载范围</span>
                  <select disabled={profileSaving} value={settings.entryLookbackDays ?? "all"} onChange={(event) => void setEntryLookback(event.target.value)}>
                    {LOOKBACK_OPTIONS.map((option) => <option key={option.value ?? "all"} value={option.value ?? "all"}>{option.label}</option>)}
                  </select>
                  <small>未读和普通已读按此范围加载；收藏始终加载全部历史。</small>
                </label>
                <div className="syncDataActions">
                  <div><strong>重新测试首次加载</strong><p>清除当前连接的文章缓存与同步进度，保留阅读画像、偏好和连接凭据。</p></div>
                  <button className="dangerAction" disabled={syncBusy || resetting} onClick={() => void resetSync()}>{resetting ? "正在重置…" : "重置同步数据"}</button>
                </div>
                <button className="disconnect" disabled={profileSaving} onClick={onDisconnect}>断开此设备上的 Miniflux</button>
              </div>
            </section>
          </>}

          {tab === "recommendation" && <div className="recommendationData">
            <section className="dataIntro">
              <div><h3>本地推荐画像</h3><p>这里展示浏览器真实保存的原始阅读事件，以及算法由它们和 Miniflux 收藏派生出的权重。推荐分数仍只用于“今天”的排序。</p></div>
              <button className="primaryAction" onClick={() => setDraft(emptyEventDraft())}>＋ 添加记录</button>
            </section>
            <section className="metricGrid">
              <div><strong>{events.length}</strong><span>阅读事件</span></div>
              <div><strong>{validEvents.length}</strong><span>有效兴趣事件</span></div>
              <div><strong>{averageSeconds}s</strong><span>平均前台停留</span></div>
              <div><strong>{averageDepth}%</strong><span>平均滚动深度</span></div>
              <div><strong>{helpfulCount}</strong><span>“有帮助”</span></div>
              <div><strong>{negativeCount}</strong><span>“不感兴趣”</span></div>
              <div><strong>{starredCount}</strong><span>Miniflux 收藏</span></div>
            </section>
            <section className="derivedData">
              <div>
                <header><h3>订阅源权重</h3><small>有效阅读与收藏，经时间衰减</small></header>
                <div className="weightList">{topSources.length ? topSources.map(([feedId, weight]) => <span key={feedId}><b>{sourceName.get(feedId) ?? `Feed ${feedId}`}</b><em>{weight.toFixed(2)}</em></span>) : <p>还没有有效权重</p>}</div>
              </div>
              <div>
                <header><h3>正向关键词</h3><small>权重最高的 20 个词</small></header>
                <div className="weightTags">{topWords.length ? topWords.map(([word, weight]) => <span key={word}>{word}<em>{weight.toFixed(1)}</em></span>) : <p>还没有关键词</p>}</div>
              </div>
              <div>
                <header><h3>负向关键词</h3><small>来自“不感兴趣”反馈</small></header>
                <div className="weightTags negative">{topNegatives.length ? topNegatives.map(([word, weight]) => <span key={word}>{word}<em>{weight.toFixed(1)}</em></span>) : <p>还没有负向关键词</p>}</div>
              </div>
            </section>

            {draft && <section className="eventEditor">
              <header><div><h3>{draft.id ? "编辑阅读事件" : "添加阅读事件"}</h3><small>滚动深度使用 0–1；关键词用逗号分隔。</small></div><button onClick={() => setDraft(null)}>×</button></header>
              <div className="eventForm">
                <label className="wide"><span>文章标题</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
                <label><span>来源</span><input value={draft.source} onChange={(event) => setDraft({ ...draft, source: event.target.value })} /></label>
                <label><span>打开时间</span><input type="datetime-local" value={draft.openedAt ? toZonedDateTimeInput(draft.openedAt, timeZone) : ""} onChange={(event) => setDraft({ ...draft, openedAt: event.target.value ? zonedDateTimeInputToIso(event.target.value, timeZone, draft.openedAt) : "" })} /></label>
                <label><span>Entry ID</span><input type="number" value={draft.entryId} onChange={(event) => setDraft({ ...draft, entryId: Number(event.target.value) })} /></label>
                <label><span>Feed ID</span><input type="number" value={draft.feedId} onChange={(event) => setDraft({ ...draft, feedId: Number(event.target.value) })} /></label>
                <label><span>前台停留（秒）</span><input type="number" min="0" value={draft.activeSeconds} onChange={(event) => setDraft({ ...draft, activeSeconds: Number(event.target.value) })} /></label>
                <label><span>滚动深度</span><input type="number" min="0" max="1" step=".01" value={draft.scrollDepth} onChange={(event) => setDraft({ ...draft, scrollDepth: Number(event.target.value) })} /></label>
                <label><span>进入路径</span><select value={draft.origin} onChange={(event) => setDraft({ ...draft, origin: event.target.value as ReadingEvent["origin"] })}><option value="recommendation">今天推荐</option><option value="feed">订阅源</option><option value="search">搜索</option><option value="saved">收藏</option></select></label>
                <label><span>明确反馈</span><select value={draft.feedback ?? ""} onChange={(event) => setDraft({ ...draft, feedback: event.target.value ? event.target.value as ReadingEvent["feedback"] : undefined })}><option value="">无</option><option value="helpful">有帮助</option><option value="not_interested">不感兴趣</option></select></label>
                <label className="wide"><span>关键词</span><input value={draft.terms.join(", ")} onChange={(event) => setDraft({ ...draft, terms: event.target.value.split(",") })} /></label>
              </div>
              <footer><button onClick={() => setDraft(null)}>取消</button><button className="primaryAction" onClick={() => void saveEvent()}>保存记录</button></footer>
            </section>}

            <section className="eventRecords">
              <header><div><h3>原始阅读事件</h3><small>{shownEvents.length} / {events.length} 条；按打开时间倒序</small></div><input value={eventQuery} onChange={(event) => setEventQuery(event.target.value)} placeholder="搜索标题、来源或关键词" /></header>
              <div className="eventTable">
                <div className="eventTableHead"><span>文章 / 来源</span><span>行为</span><span>信号</span><span /></div>
                {shownEvents.length ? shownEvents.map((event) => <div className="eventRow" key={event.id}>
                  <span><strong>{event.title}</strong><small>{event.source} · {formatZonedDateTime(event.openedAt, timeZone)}</small></span>
                  <span><b>{Math.round(event.activeSeconds)}s</b><small>滚动 {Math.round(event.scrollDepth * 100)}% · {event.origin}</small></span>
                  <span><b>{event.feedback === "helpful" ? "有帮助" : event.feedback === "not_interested" ? "不感兴趣" : "隐式"}</b><small>{event.terms.slice(0, 4).join(" · ") || "无关键词"}</small></span>
                  <span><button onClick={() => setDraft({ ...event })}>编辑</button><button className="danger" onClick={() => void removeEvent(event)}>删除</button></span>
                </div>) : <p className="noEvents">没有匹配的阅读事件。</p>}
              </div>
            </section>
          </div>}
        </div>
      </section>
    </div>
  );
}

function ConnectScreen({ onConnected }: { onConnected: (config: ConnectionConfig, settings: ProfileSettings) => void }) {
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [remember, setRemember] = useState(true);
  const [entryLookbackDays, setEntryLookbackDays] = useState<number | null>(DEFAULT_LOOKBACK_DAYS);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    const config = { url: url.trim().replace(/\/+$/, ""), apiKey: apiKey.trim(), remember };
    setTesting(true);
    setError("");
    try {
      await minifluxFetch(config, "/v1/me");
      saveConnection(config);
      const currentSettings = await getProfileSettings();
      const nextSettings = { ...currentSettings, entryLookbackDays, updatedAt: new Date().toISOString() };
      await saveProfileSettings(nextSettings);
      onConnected(config, nextSettings);
    } catch (cause) {
      setError(cause instanceof TypeError
        ? "浏览器无法直连该地址。请检查 HTTPS、地址是否正确，以及反向代理是否允许 CORS 和 X-Auth-Token。"
        : cause instanceof Error ? cause.message : "连接失败");
    } finally {
      setTesting(false);
    }
  };

  return (
    <main className="onboarding" data-theme="day">
      <div className="onboardGlow" />
      <section className="connectCard">
        <div className="connectBrand"><span className="wave">▁▅█▃▇▂</span><strong>READFLUX</strong><small>LOCAL-FIRST RSS</small></div>
        <p className="eyebrow">PRIVATE INTELLIGENCE READER</p>
        <h1>把 Miniflux 变成<br />你的个人情报终端。</h1>
        <p className="connectLead">文章由 Miniflux 提供；真实阅读行为、推荐偏好和主题只保存在这个浏览器。</p>
        <form onSubmit={connect}>
          <label><span>Miniflux 地址</span><input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://rss.example.com" autoComplete="url" /></label>
          <label><span>API Key</span><input type="password" required value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="粘贴专用 API Key" autoComplete="off" /></label>
          <label className="connectLookback"><span>首次加载</span><select value={entryLookbackDays ?? "all"} onChange={(event) => setEntryLookbackDays(event.target.value === "all" ? null : Number(event.target.value))}>{LOOKBACK_OPTIONS.map((option) => <option key={option.value ?? "all"} value={option.value ?? "all"}>{option.label}</option>)}</select><small>收藏文章始终加载全部历史</small></label>
          <label className="remember"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /><span>记住在此设备</span><small>{remember ? "保存在此浏览器" : "关闭标签页后清除"}</small></label>
          {error && <p className="formError">{error}</p>}
          <button className="connectButton" disabled={testing}>{testing ? "正在验证连接…" : "连接 Miniflux →"}</button>
        </form>
        <footer><span>● 无 ReadFlux 服务器</span><span>● Key 不会离开浏览器与 Miniflux</span></footer>
      </section>
      <aside className="connectAside">
        <div className="miniSignal"><i /><span>推荐依据</span><strong>真实阅读</strong></div>
        <div className="miniSignal"><i /><span>本地画像</span><strong>IndexedDB</strong></div>
        <div className="miniSignal"><i /><span>数据边界</span><strong>仅此设备</strong></div>
      </aside>
    </main>
  );
}

export default function App() {
  const [config, setConfig] = useState<ConnectionConfig | null>(null);
  const [ready, setReady] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [events, setEvents] = useState<ReadingEvent[]>([]);
  const [settings, setSettings] = useState<ProfileSettings>({ theme: "day", entryLookbackDays: DEFAULT_LOOKBACK_DAYS, updatedAt: new Date(0).toISOString() });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [mode, setMode] = useState<ListMode>("today");
  const [minifluxTimeZone, setMinifluxTimeZone] = useState<string>();
  const [todayClock, setTodayClock] = useState(() => Date.now());
  const timeZoneSelection = useMemo(
    () => selectTimeZone(minifluxTimeZone),
    [minifluxTimeZone],
  );
  const activeTimeZone = timeZoneSelection.timeZone;
  const todayKey = useMemo(
    () => localDayKey(todayClock, activeTimeZone),
    [todayClock, activeTimeZone],
  );
  const [topic, setTopic] = useState<Topic>(null);
  const [query, setQuery] = useState("");
  const [hideRead, setHideRead] = useState(false);
  const [listReadSnapshot, setListReadSnapshot] = useState<Map<number, Entry["status"]>>(() => {
    try {
      const stored = localStorage.getItem("readflux.listSnapshot");
      if (stored) return new Map(JSON.parse(stored) as [number, Entry["status"]][]);
    } catch { /* ignore */ }
    return new Map();
  });
  const [reasonOpen, setReasonOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(250);
  const [listWidth, setListWidth] = useState(430);
  const [subscriptionsCollapsed, setSubscriptionsCollapsed] = useState(
    () => readStoredBoolean("readflux.sidebar.subscriptions-collapsed"),
  );
  const [collapsedCategories, setCollapsedCategories] = useState<Set<number>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const saved = JSON.parse(localStorage.getItem("readflux.sidebar.collapsed-categories") ?? "[]") as number[];
      return new Set(saved.filter(Number.isFinite));
    } catch {
      localStorage.removeItem("readflux.sidebar.collapsed-categories");
      return new Set();
    }
  });
  const [feedIcons, setFeedIcons] = useState<Map<number, string>>(new Map());
  const [mobileView, setMobileView] = useState<"sources" | "list" | "reader">("list");
  const [toast, setToast] = useState("");
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [contentLoadingId, setContentLoadingId] = useState<number | null>(null);
  const [contentError, setContentError] = useState<{ id: number; message: string } | null>(null);
  const [error, setError] = useState("");
  const [pendingNew, setPendingNew] = useState(0);
  const [visibleIds, setVisibleIds] = useState<number[]>([]);
  const [referrerScopeState, setReferrerScopeState] = useState({ url: "", scope: "" });
  const activeEvent = useRef<ReadingEvent | null>(null);
  const readerRef = useRef<HTMLDivElement | null>(null);
  const syncInFlight = useRef(false);
  const syncQueued = useRef(false);
  const syncResetInProgress = useRef(false);
  const listSnapshotIds = useRef<Set<number>>(new Set());
  const visibleEmptyRef = useRef(true);
  const modeRef = useRef(mode);
  const todayKeyRef = useRef(todayKey);
  const timeZoneRef = useRef(activeTimeZone);
  const topicRef = useRef(topic);
  const feedsRef = useRef(feeds);
  const hideReadRef = useRef(hideRead);
  const queryRef = useRef(query);
  const loadRef = useRef<(options?: { background?: boolean }) => Promise<void>>(async () => {});

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }, []);

  useEffect(() => { listSnapshotIds.current = new Set(listReadSnapshot.keys()); }, [listReadSnapshot]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { todayKeyRef.current = todayKey; }, [todayKey]);
  useEffect(() => { timeZoneRef.current = activeTimeZone; }, [activeTimeZone]);
  useEffect(() => { topicRef.current = topic; }, [topic]);
  useEffect(() => { feedsRef.current = feeds; }, [feeds]);
  useEffect(() => { hideReadRef.current = hideRead; }, [hideRead]);
  useEffect(() => { queryRef.current = query; }, [query]);

  useEffect(() => {
    const now = new Date();
    const nextMidnight = nextDayBoundary(now, activeTimeZone);
    const timer = window.setTimeout(() => {
      setTodayClock(Date.now());
      if (modeRef.current === "today" && !topicRef.current) {
        setVisibleIds([]);
        setEntries((current) => {
          setListReadSnapshot(new Map(current.map((entry) => [entry.id, entry.status])));
          return current;
        });
      }
    }, Math.max(1_000, nextMidnight.getTime() - now.getTime() + 100));
    return () => window.clearTimeout(timer);
  }, [todayKey, activeTimeZone]);

  useEffect(() => {
    let cancelled = false;
    if (!config) return () => { cancelled = true; };
    void minifluxReferrerScope(config.url).then((scope) => {
      if (!cancelled) setReferrerScopeState({ url: config.url, scope });
    }).catch(() => {
      if (!cancelled) setReferrerScopeState({ url: config.url, scope: "" });
    });
    return () => { cancelled = true; };
  }, [config]);

  const referrerScope = config && referrerScopeState.url === config.url
    ? referrerScopeState.scope
    : "";

  useEffect(() => {
    Promise.all([getReadingEvents(), getProfileSettings()]).then(([history, profile]) => {
      setEvents(history);
      setSettings(profile);
      setConfig(getConnection());
      setReady(true);
    });
  }, []);

  useEffect(() => {
    localStorage.setItem("readflux.sidebar.subscriptions-collapsed", String(subscriptionsCollapsed));
  }, [subscriptionsCollapsed]);

  useEffect(() => {
    localStorage.setItem("readflux.sidebar.collapsed-categories", JSON.stringify([...collapsedCategories]));
  }, [collapsedCategories]);

  useEffect(() => {
    if (listReadSnapshot.size) {
      localStorage.setItem("readflux.listSnapshot", JSON.stringify([...listReadSnapshot]));
    } else {
      localStorage.removeItem("readflux.listSnapshot");
    }
  }, [listReadSnapshot]);

  useEffect(() => {
    const refreshSettings = () => { void getProfileSettings().then(setSettings); };
    const receiveSettings = (event: MessageEvent<{ type?: string }>) => {
      if (event.origin === window.location.origin && event.data?.type === "readflux:settings-updated") refreshSettings();
      if (event.origin === window.location.origin && event.data?.type === "readflux:disconnected") window.location.reload();
    };
    window.addEventListener("focus", refreshSettings);
    window.addEventListener("message", receiveSettings);
    return () => {
      window.removeEventListener("focus", refreshSettings);
      window.removeEventListener("message", receiveSettings);
    };
  }, []);

  const mergeEntryBatch = useCallback(async (batch: Entry[]) => {
    if (!config || !batch.length) return;
    setEntries((current) => {
      const merged = new Map(current.map((entry) => [entry.id, entry]));
      batch.forEach((entry) => {
        const cached = merged.get(entry.id);
        merged.set(entry.id, {
          ...cached,
          ...entry,
          content: entry.content || cached?.content || "",
        });
      });
      return [...merged.values()];
    });
    if (!queryRef.current.trim()) {
      const currentMode = modeRef.current;
      const currentTopic = topicRef.current;
      const currentHideRead = hideReadRef.current;
      const relevant = batch.filter((entry) => {
        if (listSnapshotIds.current.has(entry.id)) return false;
        if (!currentTopic && !isEntryInSmartFeed(
          entry,
          currentMode,
          todayKeyRef.current,
          timeZoneRef.current,
        )) return false;
        if (currentHideRead && entry.status === "read") return false;
        if (currentTopic?.kind === "category") {
          const feed = feedsRef.current.find((f) => f.id === entry.feed_id);
          if (feed?.category?.id !== currentTopic.id) return false;
        }
        if (currentTopic?.kind === "feed" && entry.feed_id !== currentTopic.id) return false;
        return true;
      });
      if (relevant.length) {
        if (visibleEmptyRef.current) {
          setListReadSnapshot((current) => {
            const next = new Map(current);
            relevant.forEach((entry) => next.set(entry.id, entry.status));
            return next;
          });
        } else {
          setPendingNew((n) => n + relevant.length);
        }
      }
    }
    await putCachedEntries(config, batch);
  }, [config]);

  const lookbackDays = settings.entryLookbackDays === undefined
    ? DEFAULT_LOOKBACK_DAYS
    : settings.entryLookbackDays;

  const load = useCallback(async (options?: { background?: boolean }) => {
    if (!config) return;
    if (syncResetInProgress.current || syncInFlight.current) {
      syncQueued.current = true;
      return;
    }
    const background = options?.background ?? false;
    syncInFlight.current = true;
    setLoading(true);
    setError("");
    const syncStartedAt = new Date().toISOString();
    try {
      const [cached, storedState, timeZone] = await Promise.all([
        getCachedEntries<Entry>(config),
        getEntrySyncState(config),
        loadOptionalMinifluxTimeZone(
          () => minifluxFetch<MinifluxUser>(config, "/v1/me"),
        ),
      ]);
      setMinifluxTimeZone(timeZone);
      const cutoff = lookbackDays === null
        ? null
        : Date.now() - lookbackDays * 86_400_000;
      const scopedCache = cached.filter((entry) =>
        entry.starred || cutoff === null || new Date(entry.published_at).getTime() >= cutoff);
      setEntries(scopedCache);
      if (!listSnapshotIds.current.size || !scopedCache.some((e) => listSnapshotIds.current.has(e.id))) {
        setListReadSnapshot(new Map(scopedCache.map((entry) => [entry.id, entry.status])));
      }
      const [feedData, categoryData] = await Promise.all([
        minifluxFetch<Feed[]>(config, "/v1/feeds"),
        minifluxFetch<Category[]>(config, "/v1/categories"),
      ]);
      setFeeds(feedData ?? []);
      setCategories(categoryData ?? []);
      setSelectedId((current) => current && scopedCache.some((entry) => entry.id === current) ? current : null);

      const needsInitialSync = !storedState?.initialSyncComplete
        || storedState.lookbackDays !== lookbackDays;
      if (needsInitialSync) {
        const publishedAfter: Record<string, string> = lookbackDays === null
          ? {}
          : { published_after: String(Math.floor((Date.now() - lookbackDays * 86_400_000) / 1000)) };
        const phases: { id: EntrySyncPhase; filters: Record<string, string> }[] = [
          { id: "unread", filters: { status: "unread", ...publishedAfter } },
          { id: "starred", filters: { starred: "true" } },
          { id: "read", filters: { status: "read", starred: "false", ...publishedAfter } },
        ];
        const resumeIndex = storedState?.lookbackDays === lookbackDays && storedState.phase
          ? Math.max(0, phases.findIndex((phase) => phase.id === storedState.phase))
          : 0;
        for (let index = resumeIndex; index < phases.length; index += 1) {
          const phase = phases[index];
          const startOffset = index === resumeIndex
            && storedState?.lookbackDays === lookbackDays
            && storedState.phase === phase.id
            ? storedState.offset ?? 0
            : 0;
          await loadEntryPages(config, phase.filters, async (batch, loaded, total, nextOffset) => {
            setSyncProgress({ kind: "initial", phase: phase.id, loaded, total });
            await mergeEntryBatch(batch);
            await saveEntrySyncState(config, {
              initialSyncComplete: false,
              lookbackDays,
              phase: phase.id,
              offset: nextOffset,
            });
          }, startOffset);
          const nextPhase = phases[index + 1]?.id;
          if (nextPhase) {
            await saveEntrySyncState(config, {
              initialSyncComplete: false,
              lookbackDays,
              phase: nextPhase,
              offset: 0,
            });
          }
        }
      } else if (storedState.updatedAt) {
        const changedAfter = Math.max(0, Math.floor(new Date(storedState.updatedAt).getTime() / 1000) - 1);
        await loadEntryPages(config, { changed_after: String(changedAfter) }, async (batch, loaded, total) => {
          setSyncProgress({ kind: "incremental", loaded, total });
          const visibleBatch = batch.filter((entry) =>
            entry.starred || cutoff === null || new Date(entry.published_at).getTime() >= cutoff);
          const hiddenIds = new Set(batch.filter((entry) => !visibleBatch.includes(entry)).map((entry) => entry.id));
          if (hiddenIds.size) setEntries((current) => current.filter((entry) => !hiddenIds.has(entry.id)));
          await mergeEntryBatch(visibleBatch);
          await putCachedEntries(config, batch);
        });
      }

      await saveEntrySyncState(config, {
        initialSyncComplete: true,
        lookbackDays,
        updatedAt: syncStartedAt,
      });
      setSyncedAt(new Date());
      if (!background && !listSnapshotIds.current.size) {
        setEntries((current) => {
          setListReadSnapshot(new Map(current.map((entry) => [entry.id, entry.status])));
          return current;
        });
        setPendingNew(0);
      }
    } catch (cause) {
      setError(cause instanceof TypeError
        ? "浏览器无法直连 Miniflux，请检查网络与 CORS 配置。"
        : cause instanceof Error ? cause.message : "无法连接 Miniflux");
    } finally {
      setLoading(false);
      setSyncProgress(null);
      syncInFlight.current = false;
      if (syncQueued.current) {
        syncQueued.current = false;
        queueMicrotask(() => void loadRef.current());
      }
    }
  }, [config, lookbackDays, mergeEntryBatch]);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    if (config) queueMicrotask(() => void load());
  }, [config, load]);

  useEffect(() => {
    if (!config || !query.trim() || loading) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        limit: "250",
        order: "published_at",
        direction: "desc",
        search: query.trim(),
      });
      setSyncProgress({ kind: "search", loaded: 0, total: 0 });
      void minifluxFetch<EntryPage>(config, `/v1/entries?${params}`)
        .then(async (page) => {
          if (cancelled) return;
          const batch = page.entries ?? [];
          await mergeEntryBatch(batch);
          if (!cancelled) setSyncProgress({ kind: "search", loaded: batch.length, total: page.total ?? batch.length });
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setSyncProgress((current) => current?.kind === "search" ? null : current);
        });
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, config, mergeEntryBatch, loading]);

  useEffect(() => {
    if (!config) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadRef.current({ background: true });
    }, 5 * 60_000);
    return () => { window.clearInterval(timer); };
  }, [config]);

  useEffect(() => {
    if (!config || !feeds.length) return;
    let cancelled = false;
    const withIcons = feeds.filter((feed) => feed.icon);
    void Promise.all(withIcons.map(async (feed) => {
      try {
        const icon = await minifluxFetch<FeedIcon>(config, `/v1/feeds/${feed.id}/icon`);
        const src = icon.data.startsWith("data:") ? icon.data : `data:${icon.data}`;
        return [feed.id, src] as const;
      } catch {
        return null;
      }
    })).then((results) => {
      if (cancelled) return;
      setFeedIcons(new Map(results.filter((item): item is readonly [number, string] => item !== null)));
    });
    return () => { cancelled = true; };
  }, [config, feeds]);

  const feedMap = useMemo(() => new Map(feeds.map((feed) => [feed.id, feed])), [feeds]);
  const interest = useMemo(() => {
    const sources = new Map<number, number>();
    const words = new Map<string, number>();
    const negatives = new Map<string, number>();
    const now = syncedAt?.getTime() ?? 0;
    events.forEach((event) => {
      const ageDays = Math.max(0, (now - new Date(event.openedAt).getTime()) / 86_400_000);
      const recency = Math.exp(-ageDays / 28);
      const engaged = Math.min(4, event.activeSeconds / 30) + event.scrollDepth * 2;
      const positive = event.feedback === "helpful" ? 5 : engaged;
      if (event.feedback === "not_interested") {
        event.terms.forEach((term) => negatives.set(term, (negatives.get(term) ?? 0) + 4 * recency));
        return;
      }
      if (event.activeSeconds < 6 && event.scrollDepth < 0.15 && event.feedback !== "helpful") return;
      const weight = Math.max(0.2, positive) * recency;
      sources.set(event.feedId, (sources.get(event.feedId) ?? 0) + weight);
      event.terms.forEach((term) => words.set(term, (words.get(term) ?? 0) + weight));
    });
    entries.filter((entry) => entry.starred).forEach((entry) => {
      sources.set(entry.feed_id, (sources.get(entry.feed_id) ?? 0) + 5);
      termsOf(`${entry.title} ${toText(entry.content).slice(0, 500)}`).forEach((term) => words.set(term, (words.get(term) ?? 0) + 3));
    });
    return { sources, words, negatives };
  }, [events, entries, syncedAt]);

  const stories = useMemo<Story[]>(() => entries.map((entry) => {
    const feed = entry.feed ?? feedMap.get(entry.feed_id);
    const source = feed?.title ?? "未知来源";
    const category = feed?.category?.title ?? "未分组";
    const titleTerms = termsOf(`${entry.title} ${toText(entry.content).slice(0, 240)}`);
    const hits = titleTerms.map((word) => [word, interest.words.get(word) ?? 0] as const).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
    const negative = titleTerms.reduce((sum, word) => sum + (interest.negatives.get(word) ?? 0), 0);
    const sourceAffinity = interest.sources.get(entry.feed_id) ?? 0;
    const ageDays = Math.max(0, ((syncedAt?.getTime() ?? 0) - new Date(entry.published_at).getTime()) / 86_400_000);
    const freshness = Math.max(0, 12 - Math.floor(ageDays));
    const score = Math.max(1, Math.min(99, Math.round(44 + Math.min(25, sourceAffinity * 3) + Math.min(20, hits.reduce((sum, [, value]) => sum + value, 0)) + freshness + (entry.starred ? 8 : 0) - negative * 2)));
    const reason = sourceAffinity >= 2
      ? `你最近在「${source}」有真实阅读行为${hits[0] ? `，并持续关注「${hits.slice(0, 2).map(([word]) => word).join("、")}」` : ""}。`
      : hits[0]
        ? `主题命中了近期认真阅读或收藏中的兴趣词「${hits.slice(0, 2).map(([word]) => word).join("、")}」。`
        : events.length
          ? `来自「${category}」，结合发布时间与本地兴趣画像进入队列。`
          : "兴趣画像还很轻；阅读几篇文章后，推荐依据会逐渐个性化。";
    const summary = toText(entry.content).slice(0, 160);
    return {
      ...entry,
      source,
      category,
      categoryId: feed?.category?.id,
      mark: source.trim().slice(0, 1).toUpperCase() || "·",
      summary: summary ? `${summary}${summary.length >= 160 ? "…" : ""}` : "这篇文章暂时没有摘要。",
      score,
      reason,
    };
  }), [entries, events.length, feedMap, interest, syncedAt]);

  const persistActive = useCallback(async () => {
    if (!activeEvent.current) return;
    activeEvent.current.updatedAt = new Date().toISOString();
    await putReadingEvent(activeEvent.current);
  }, []);

  const commitActiveEvent = useCallback(() => {
    if (!activeEvent.current) return;
    const snapshot = { ...activeEvent.current };
    setEvents((all) => {
      const index = all.findIndex((event) => event.id === snapshot.id);
      return index < 0 ? [...all, snapshot] : all.map((event, i) => i === index ? snapshot : event);
    });
  }, []);

  const refreshList = useCallback(() => {
    commitActiveEvent();
    setVisibleIds([]);
    setEntries((current) => {
      setListReadSnapshot(new Map(current.map((entry) => [entry.id, entry.status])));
      return current;
    });
    setPendingNew(0);
  }, [commitActiveEvent]);

  const visible = useMemo(() => {
    const hasQuery = !!query.trim();
    const needle = hasQuery ? query.trim().toLowerCase() : "";
    const filtered = stories.filter((story) => {
      if (!hasQuery && !listReadSnapshot.has(story.id)) return false;
      const statusWhenListed = listReadSnapshot.get(story.id) ?? story.status;
      if (!topic && !isEntryInSmartFeed(
        { ...story, status: statusWhenListed },
        mode,
        todayKey,
        activeTimeZone,
      )) return false;
      if (hideRead && statusWhenListed === "read") return false;
      if (topic?.kind === "category" && story.categoryId !== topic.id) return false;
      if (topic?.kind === "feed" && story.feed_id !== topic.id) return false;
      if (!hasQuery) return true;
      return `${story.title} ${story.summary} ${story.source} ${story.author ?? ""}`.toLowerCase().includes(needle);
    });
    if (visibleIds.length) {
      const orderIndex = new Map(visibleIds.map((id, i) => [id, i]));
      filtered.sort((a, b) => {
        const ai = orderIndex.get(a.id);
        const bi = orderIndex.get(b.id);
        if (ai !== undefined && bi !== undefined) return ai - bi;
        if (ai !== undefined) return -1;
        if (bi !== undefined) return 1;
        return compareSmartFeedEntries(a, b, topic ? "unread" : mode);
      });
    } else {
      filtered.sort((a, b) => compareSmartFeedEntries(a, b, topic ? "unread" : mode));
    }
    return filtered;
  }, [stories, mode, topic, query, hideRead, listReadSnapshot, visibleIds, todayKey, activeTimeZone]);

  useEffect(() => {
    if (visible.length && !visibleIds.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- captures sort order after fresh sort
      setVisibleIds(visible.map((s) => s.id));
    }
  }, [visible, visibleIds]);

  useEffect(() => { visibleEmptyRef.current = !visible.length; }, [visible]);

  const selected = stories.find((story) => story.id === selectedId) ?? null;

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!activeEvent.current || document.visibilityState !== "visible" || !document.hasFocus()) return;
      activeEvent.current.activeSeconds += 5;
      void persistActive();
    }, 5000);
    const flush = () => { commitActiveEvent(); void persistActive(); };
    window.addEventListener("pagehide", flush);
    return () => { window.clearInterval(timer); window.removeEventListener("pagehide", flush); commitActiveEvent(); void persistActive(); };
  }, [persistActive, commitActiveEvent]);

  const updateEntry = async (id: number, patch: Partial<Entry>, request: () => Promise<unknown>, success: string) => {
    const before = entries;
    setEntries((all) => all.map((entry) => entry.id === id ? { ...entry, ...patch } : entry));
    try {
      await request();
      const cached = before.find((entry) => entry.id === id);
      if (config && cached) await putCachedEntries(config, [{ ...cached, ...patch }]);
      notify(success);
    } catch (cause) {
      setEntries(before);
      notify(cause instanceof Error ? cause.message : "同步失败");
    }
  };

  const loadEntryContent = useCallback(async (id: number) => {
    if (!config) return;
    setContentLoadingId(id);
    setContentError(null);
    try {
      const remote = await minifluxFetch<Entry>(config, `/v1/entries/${id}`);
      const local = entries.find((entry) => entry.id === id);
      const merged = local
        ? { ...local, ...remote, status: local.status, starred: local.starred }
        : remote;
      setEntries((all) => all.map((entry) => entry.id === id ? merged : entry));
      await putCachedEntries(config, [merged]);
    } catch (cause) {
      setContentError({
        id,
        message: cause instanceof Error ? cause.message : "文章正文加载失败",
      });
    } finally {
      setContentLoadingId((current) => current === id ? null : current);
    }
  }, [config, entries]);

  const choose = useCallback((story: Story, origin?: ReadingEvent["origin"]) => {
    void persistActive();
    setSelectedId(story.id);
    setContentError(null);
    if (!story.content.trim()) void loadEntryContent(story.id);
    readerRef.current?.scrollTo({ top: 0 });
    activeEvent.current = newReadingEvent({
      entryId: story.id,
      feedId: story.feed_id,
      title: story.title,
      source: story.source,
      terms: termsOf(`${story.title} ${story.summary}`),
      origin: origin ?? (query ? "search" : mode === "today" ? "recommendation" : mode === "saved" ? "saved" : "feed"),
    });
    void putReadingEvent(activeEvent.current);
    if (story.status === "unread" && config) {
      void updateEntry(story.id, { status: "read" }, () => minifluxFetch(config, "/v1/entries", {
        method: "PUT",
        body: JSON.stringify({ entry_ids: [story.id], status: "read" }),
      }), "已标为已读");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, mode, query, persistActive, loadEntryContent]);

  const move = useCallback((delta: number) => {
    if (!visible.length) return;
    const current = visible.findIndex((story) => story.id === selectedId);
    choose(visible[Math.max(0, Math.min(visible.length - 1, Math.max(0, current) + delta))]);
  }, [visible, selectedId, choose]);

  const toggleRead = useCallback((story: Story) => {
    if (!config) return;
    const status = story.status === "read" ? "unread" : "read";
    void updateEntry(story.id, { status }, () => minifluxFetch(config, "/v1/entries", {
      method: "PUT",
      body: JSON.stringify({ entry_ids: [story.id], status }),
    }), status === "read" ? "已标为已读" : "已标为未读");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, entries]);

  const markVisibleRead = useCallback(async () => {
    if (!config) return;
    const ids = visible.filter((story) => story.status === "unread").map((story) => story.id);
    if (!ids.length) return notify("当前列表没有未读文章");
    const before = entries;
    const after = entries.map((entry) => ids.includes(entry.id) ? { ...entry, status: "read" as const } : entry);
    setEntries(after);
    setVisibleIds([]);
    setListReadSnapshot(new Map(after.map((entry) => [entry.id, entry.status])));
    try {
      await minifluxFetch(config, "/v1/entries", {
        method: "PUT",
        body: JSON.stringify({ entry_ids: ids, status: "read" }),
      });
      await putCachedEntries(config, after.filter((entry) => ids.includes(entry.id)));
      notify(`已将 ${ids.length} 篇文章标为已读`);
    } catch (cause) {
      setEntries(before);
      setVisibleIds([]);
      setListReadSnapshot(new Map(before.map((entry) => [entry.id, entry.status])));
      notify(cause instanceof Error ? cause.message : "同步失败");
    }
  }, [config, entries, notify, visible]);

  const startResize = (kind: "sidebar" | "list", event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startValue = kind === "sidebar" ? sidebarWidth : listWidth;
    const onMove = (moveEvent: PointerEvent) => {
      const next = startValue + moveEvent.clientX - startX;
      if (kind === "sidebar") setSidebarWidth(Math.max(190, Math.min(360, next)));
      else setListWidth(Math.max(330, Math.min(620, next)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (settingsOpen) return;
      if (["INPUT", "TEXTAREA"].includes((event.target as HTMLElement).tagName)) return;
      if (event.key === "/") { event.preventDefault(); document.querySelector<HTMLInputElement>("#search")?.focus(); }
      if (event.key.toLowerCase() === "j" || event.key === "ArrowDown") move(1);
      if (event.key.toLowerCase() === "k" || event.key === "ArrowUp") move(-1);
      if (event.key.toLowerCase() === "n") {
        const current = visible.findIndex((story) => story.id === selectedId);
        const nextUnread = [...visible.slice(current + 1), ...visible.slice(0, current + 1)].find((story) => story.status === "unread");
        if (nextUnread) choose(nextUnread);
      }
      if (!selected || !config) return;
      if (event.key.toLowerCase() === "s") void updateEntry(selected.id, { starred: !selected.starred }, () => minifluxFetch(config, `/v1/entries/${selected.id}/bookmark`, { method: "PUT" }), selected.starred ? "已取消收藏" : "已收藏");
      if (["m", "u", "r"].includes(event.key.toLowerCase())) toggleRead(selected);
      if (event.key === "Enter") window.open(selected.url, "_blank", "noopener,noreferrer");
      if (event.key === " ") {
        event.preventDefault();
        const reader = readerRef.current;
        if (reader && reader.scrollTop + reader.clientHeight < reader.scrollHeight - 12) reader.scrollBy({ top: reader.clientHeight * .8, behavior: "smooth" });
        else move(1);
      }
      if (event.shiftKey && event.key.toLowerCase() === "a") void markVisibleRead();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, move, selected, entries, visible, selectedId, choose, toggleRead, markVisibleRead, settingsOpen]);

  const setFeedback = async (feedback: "helpful" | "not_interested") => {
    if (!selected) return;
    if (!activeEvent.current || activeEvent.current.entryId !== selected.id) choose(selected);
    if (activeEvent.current) {
      activeEvent.current.feedback = feedback;
      await persistActive();
    }
    if (feedback === "not_interested") {
      const next = visible.find((story) => story.id !== selected.id);
      setSelectedId(next?.id ?? null);
      notify("已降低相似主题的推荐");
    } else {
      notify("已强化这类内容");
    }
  };

  const categorySources = useMemo(() => categories.map((category) => ({
    ...category,
    feeds: feeds.filter((feed) => feed.category?.id === category.id),
  })), [categories, feeds]);
  const unreadByFeed = useMemo(() => {
    const counts = new Map<number, number>();
    entries.forEach((entry) => {
      if (entry.status === "unread") counts.set(entry.feed_id, (counts.get(entry.feed_id) ?? 0) + 1);
    });
    return counts;
  }, [entries]);
  const topicTitle = topic?.kind === "category"
    ? categories.find((category) => category.id === topic.id)?.title
    : topic?.kind === "feed"
      ? feeds.find((feed) => feed.id === topic.id)?.title
      : null;
  const toggleCategory = (categoryId: number, force?: boolean) => {
    setCollapsedCategories((current) => {
      const next = new Set(current);
      const collapse = force ?? !next.has(categoryId);
      if (collapse) next.add(categoryId);
      else next.delete(categoryId);
      return next;
    });
  };
  const handleSidebarKey = (event: React.KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (!target.matches("[data-sidebar-row]")) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-sidebar-row]:not([hidden])")];
    const index = rows.indexOf(target);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
    }
  };
  const { unreadCount, todayUnreadCount, savedCount } = useMemo(
    () => countSmartFeedEntries(entries, todayKey, activeTimeZone),
    [entries, todayKey, activeTimeZone],
  );
  const syncProgressLabel = syncProgress
    ? `${syncProgress.kind === "initial"
      ? `首次同步 · ${syncProgress.phase === "unread" ? "未读" : syncProgress.phase === "starred" ? "全部收藏" : "已读"}`
      : syncProgress.kind === "search" ? "搜索 Miniflux" : "获取最新文章"}${syncProgress.total ? ` ${syncProgress.loaded} / ${syncProgress.total}` : ""}`
    : "";
  if (!ready) return <main className="boot" data-theme="day"><span className="wave">▁▅█▃▇▂</span><p>正在启动阅读器…</p></main>;
  if (!config) return <ConnectScreen onConnected={(nextConfig, nextSettings) => {
    setSettings(nextSettings);
    setConfig(nextConfig);
  }} />;

  const nav = [
    ["today", "bi-brightness-high-fill", "今天", todayUnreadCount],
    ["unread", "bi-circle-fill", "全部未读", unreadCount],
    ["saved", "bi-star-fill", "已收藏", savedCount],
  ] as const;

  return (
    <main className="shell" data-theme={settings.theme}>
      <header className="topbar">
        <div className="brand"><strong>ReadFlux</strong></div>
        <label className="search"><span>⌕</span><input id="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文章" /><kbd>/</kbd></label>
        <div className="topActions">
          {error && <span className="syncError">同步失败</span>}
          {syncProgress && <span className="syncLabel" role="status">{syncProgressLabel}</span>}
          <button className={`toolbarButton ${loading ? "spinning" : ""}`} disabled={loading} onClick={async () => { try { await minifluxFetch(config, "/v1/feeds/refresh", { method: "PUT" }); await load(); refreshList(); notify("Miniflux 已刷新"); } catch (cause) { notify(cause instanceof Error ? cause.message : "刷新失败"); } }} aria-label="刷新订阅" title="刷新订阅"><i className="bi bi-arrow-clockwise" aria-hidden="true" /></button>
          <button className="settingsButton" onClick={() => setSettingsOpen(true)} aria-label="打开设置对话框" title="设置"><i className="bi bi-gear" aria-hidden="true" /></button>
        </div>
        {syncProgress && <div className="topbarProgress" aria-hidden="true"><i style={{ width: `${syncProgress.total ? Math.min(100, syncProgress.loaded / syncProgress.total * 100) : 8}%` }} /></div>}
      </header>

      <div className={`workspace mobile-${mobileView}`} style={{ "--sidebar-width": `${sidebarWidth}px`, "--list-width": `${listWidth}px` } as CSSProperties}>
        <aside className="sidebar" aria-label="订阅源">
          <div className="sidebarScroll" onKeyDown={handleSidebarKey}>
            <nav>{nav.map(([key, icon, label, count]) => <button data-sidebar-row key={key} className={mode === key && !topic ? "active" : ""} onClick={() => { setVisibleIds([]); setListReadSnapshot(new Map(entries.map((entry) => [entry.id, entry.status]))); setMode(key); setTopic(null); setMobileView("list"); }}><i className={`bi ${icon}`} aria-hidden="true" /><span>{label}</span><em>{count}</em></button>)}</nav>
            <div className="sideLabel"><span>订阅</span><button type="button" onClick={() => setSubscriptionsCollapsed((current) => !current)} title={subscriptionsCollapsed ? "展开订阅" : "折叠订阅"} aria-label={subscriptionsCollapsed ? "展开订阅" : "折叠订阅"} aria-expanded={!subscriptionsCollapsed}><i className={`bi ${subscriptionsCollapsed ? "bi-chevron-right" : "bi-chevron-down"}`} aria-hidden="true" /></button></div>
            {!subscriptionsCollapsed && categorySources.map((category) => {
              const collapsed = collapsedCategories.has(category.id);
              const categorySelected = topic?.kind === "category" && topic.id === category.id;
              const categoryUnread = category.feeds.reduce((sum, feed) => sum + (unreadByFeed.get(feed.id) ?? 0), 0);
              return <section className="sourceGroup" key={category.id}>
                <div className={`groupRow ${categorySelected ? "selected" : ""}`}>
                  <button className="disclosure" onClick={() => toggleCategory(category.id)} aria-label={`${collapsed ? "展开" : "折叠"}${category.title}`} aria-expanded={!collapsed}><i className={`bi ${collapsed ? "bi-folder-fill" : "bi-folder2-open"}`} aria-hidden="true" /></button>
                  <button
                    data-sidebar-row
                    className="groupHead"
                    aria-current={categorySelected ? "page" : undefined}
                    onClick={() => { setVisibleIds([]); setListReadSnapshot(new Map(entries.map((entry) => [entry.id, entry.status]))); setTopic({ kind: "category", id: category.id }); setMobileView("list"); }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); toggleCategory(category.id, true); }
                      if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); toggleCategory(category.id, false); }
                      if (event.key === " ") { event.preventDefault(); event.stopPropagation(); toggleCategory(category.id); }
                    }}
                  ><span>{category.title}</span><em>{categoryUnread || ""}</em></button>
                </div>
                {!collapsed && <div className="groupFeeds">
                  {category.feeds.map((feed) => <button data-sidebar-row className={topic?.kind === "feed" && topic.id === feed.id ? "sourceRow selected" : "sourceRow"} key={feed.id} onClick={() => { setVisibleIds([]); setListReadSnapshot(new Map(entries.map((entry) => [entry.id, entry.status]))); setTopic({ kind: "feed", id: feed.id }); setMobileView("list"); }}><SourceIcon src={feedIcons.get(feed.id)}>{feed.title.slice(0, 1)}</SourceIcon><span>{feed.title}</span><em>{unreadByFeed.get(feed.id) || ""}</em></button>)}
                </div>}
              </section>;
            })}
          </div>
        </aside>
        <div className="resizeHandle sidebarHandle" onPointerDown={(event) => startResize("sidebar", event)} onDoubleClick={() => setSidebarWidth(250)} />

        <section className="feed">
          <header className="feedTitle"><button className="mobileBack" onClick={() => setMobileView("sources")}>‹ 订阅源</button><div><h1>{topicTitle || (mode === "today" ? "今天" : mode === "unread" ? "全部未读" : "已收藏")}</h1><small>{visible.length} 篇文章{error && entries.length ? " · 离线缓存" : syncedAt ? ` · ${formatZonedTime(syncedAt, activeTimeZone)} 已同步` : ""}</small></div></header>
          <div className="feedTools"><label><input type="checkbox" checked={hideRead} onChange={(event) => { setVisibleIds([]); setListReadSnapshot(new Map(entries.map((entry) => [entry.id, entry.status]))); setHideRead(event.target.checked); }} /> 隐藏已读</label><button onClick={() => void markVisibleRead()} disabled={!visible.some((story) => story.status === "unread")}>全部标为已读</button></div>
          <div className="storyList">
            {pendingNew > 0 && <button className="newArticlesPill" onClick={refreshList}>{pendingNew} 篇新文章 ↑</button>}
            {loading && !entries.length ? <div className="empty"><b className="loadingMark">↻</b><h2>正在同步文章</h2><p>未读文章会优先显示，随后加载收藏和已读文章。</p></div>
              : error && !entries.length ? <div className="empty errorState"><b>!</b><h2>连接失败</h2><p>{error}</p><button onClick={() => void load()}>重新连接</button></div>
              : visible.length ? visible.map((story) => <article key={story.id} tabIndex={0} className={`story ${selected?.id === story.id ? "selected" : ""} ${story.status === "read" ? "read" : ""}`} onClick={() => { choose(story); setMobileView("reader"); }} onKeyDown={(event) => { if (event.key === "Enter") { choose(story); setMobileView("reader"); } }}>
                <div className="storySource"><SourceIcon src={feedIcons.get(story.feed_id)}>{story.mark}</SourceIcon><span>{story.source}</span><time>{formatZonedTime(story.published_at, activeTimeZone)}</time>{story.starred && <b>★</b>}</div>
                <h2>{story.title}</h2><p>{story.summary}</p>
                <footer><i /><span>{story.status === "unread" ? "未读" : "已读"}</span><span>·</span><span>{story.reading_time || 1} 分钟</span></footer>
              </article>) : <div className="empty"><b>✓</b><h2>这里没有文章</h2><p>换一个订阅源，或关闭“隐藏已读”。</p><button onClick={() => { setVisibleIds([]); setListReadSnapshot(new Map(entries.map((entry) => [entry.id, entry.status]))); setQuery(""); setTopic(null); setMode("today"); setHideRead(false); }}>重置</button></div>}
          </div>
        </section>
        <div className="resizeHandle listHandle" onPointerDown={(event) => startResize("list", event)} onDoubleClick={() => setListWidth(430)} />

        <article className="reader">
          {selected ? <>
            <div className="readerScroll" ref={readerRef} onScroll={(event) => {
              if (!activeEvent.current) return;
              const target = event.currentTarget;
              const depth = target.scrollHeight <= target.clientHeight ? 1 : target.scrollTop / (target.scrollHeight - target.clientHeight);
              activeEvent.current.scrollDepth = Math.max(activeEvent.current.scrollDepth, Math.min(1, depth));
            }}>
              <div className="readerToolbar"><button className="mobileBack" onClick={() => setMobileView("list")}>‹ 文章</button><div><button onClick={() => toggleRead(selected)} title={selected.status === "read" ? "标为未读" : "标为已读"}>{selected.status === "read" ? "○" : "●"}</button><button className={selected.starred ? "pressed" : ""} title={selected.starred ? "取消收藏" : "收藏"} onClick={() => void updateEntry(selected.id, { starred: !selected.starred }, () => minifluxFetch(config, `/v1/entries/${selected.id}/bookmark`, { method: "PUT" }), selected.starred ? "已取消收藏" : "已收藏")}>{selected.starred ? "★" : "☆"}</button><a href={selected.url} target="_blank" rel="noreferrer" title="打开原文">↗</a><button title="复制链接" onClick={async () => { await navigator.clipboard.writeText(selected.url); notify("原文链接已复制"); }}>⧉</button><button title="不感兴趣" onClick={() => void setFeedback("not_interested")}>−</button></div></div>
              <p className="crumb">{selected.category}　›　{selected.source}</p>
              <header className="articleHead"><div><h2>{selected.title}</h2><p><SourceIcon src={feedIcons.get(selected.feed_id)}>{selected.mark}</SourceIcon>{selected.author || selected.source}　·　{formatZonedDateTime(selected.published_at, activeTimeZone)}　·　{selected.reading_time || 1} 分钟</p></div></header>
              <section className="reason">
                <button className="reasonHead" onClick={() => setReasonOpen(!reasonOpen)}><span>推荐依据</span><small>{reasonOpen ? "收起 −" : "查看 +"}</small></button>
                {reasonOpen && <><p>{selected.reason}</p><div className="tags">{[selected.category, selected.source, ...(selected.tags ?? [])].slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}</div></>}
              </section>
              {contentLoadingId === selected.id
                ? <div className="articleLoading" role="status"><b className="loadingMark">↻</b><p>正在加载文章正文…</p></div>
                : contentError?.id === selected.id
                  ? <div className="articleLoading errorState"><b>!</b><p>{contentError.message}</p><button onClick={() => void loadEntryContent(selected.id)}>重试</button></div>
                  : <div className="body articleContent" dangerouslySetInnerHTML={{ __html: safeHtml(
                      selected.content,
                      settings.originReferrerFeeds?.[referrerScope]?.includes(selected.feed_id) ?? false,
                    ) }} />}
              <div className="feedback"><span>这篇文章符合你的兴趣吗？</span><button onClick={() => void setFeedback("helpful")}>有帮助</button><button onClick={() => void setFeedback("not_interested")}>不感兴趣</button></div>
            </div>
            <footer className="readerFoot"><span><kbd>J</kbd><kbd>K</kbd> 上下篇　<kbd>S</kbd> 收藏　<kbd>U</kbd> 已读</span><div><button onClick={() => move(-1)}>← 上一篇</button><button onClick={() => move(1)}>下一篇 →</button></div></footer>
          </> : <div className="empty readerEmpty"><b>☷</b><h2>选择一篇文章</h2><p>打开文章后，真实阅读行为才会用于调整“今天”。</p></div>}
        </article>
      </div>

      {settingsOpen && <SettingsDialog
        config={config}
        feeds={feeds}
        referrerScope={referrerScope}
        events={events}
        settings={settings}
        timeZone={activeTimeZone}
        timeZoneSource={timeZoneSelection.source}
        sourceWeights={interest.sources}
        wordWeights={interest.words}
        negativeWeights={interest.negatives}
        starredCount={savedCount}
        onClose={() => setSettingsOpen(false)}
        onSettingsChange={setSettings}
        onEventsChange={(next) => {
          if (activeEvent.current && !next.some((event) => event.id === activeEvent.current?.id)) activeEvent.current = null;
          setEvents(next);
        }}
        onDisconnect={() => {
          clearConnection();
          setSettingsOpen(false);
          setConfig(null);
        }}
        onResetSync={async () => {
          syncResetInProgress.current = true;
          try {
            while (syncInFlight.current) {
              await new Promise((resolve) => window.setTimeout(resolve, 50));
            }
            await resetEntrySync(config);
            setEntries([]);
            setListReadSnapshot(new Map());
            setSelectedId(null);
            setSyncedAt(null);
            setSyncProgress(null);
            setContentError(null);
            setSettingsOpen(false);
            notify("同步数据已重置，正在重新执行首次加载");
          } finally {
            syncResetInProgress.current = false;
          }
          await load();
        }}
        syncBusy={loading}
        notify={notify}
      />}
      {toast && <div className="toast">✓　{toast}</div>}
    </main>
  );
}
