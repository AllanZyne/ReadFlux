import { CSSProperties, FormEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  containsMinifluxProxyURL,
  detectMinifluxProxySupport,
  imageReferrerPolicy,
  imageURLForMode,
  minifluxReferrerScope,
  resolveImageLoadingMode,
  shouldRefreshProxyContent,
  updateDefaultImageLoadingMode,
  updateFeedImageLoadingMode,
  type ImageLoadingMode,
} from "./article-images";
import { articleMediaURL, isWeiboLivePhotoURL, youtubeEmbedURL } from "./article-content";
import { runExclusive } from "./async-lock";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "./i18n";
import { startOptionalMinifluxTimeZoneLoad } from "./miniflux-timezone.mjs";
import { compareSmartFeedEntries, countSmartFeedEntries, formatZonedDateTime, formatZonedTime, isEntryInSmartFeed, localDayKey, nextDayBoundary, selectTimeZone, toZonedDateTimeInput, zonedDateTimeInputToIso } from "./smart-feeds.mjs";
import {
  addEntryLabel,
  clearConnection,
  ConnectionConfig,
  deleteReadingEvent,
  EntrySyncPhase,
  getCachedEntries,
  getConnection,
  getEntryLabels,
  getEntrySyncState,
  getProfileSettings,
  getReadingEvents,
  MinifluxRequestError,
  minifluxFetch,
  newReadingEvent,
  normalizeReadingEventOpenedAt,
  putCachedEntries,
  ProfileSettings,
  putReadingEvent,
  ReadingEvent,
  removeEntryLabel,
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
  changed_at?: string;
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
  { value: 7, key: "lookback.days7" },
  { value: 30, key: "lookback.days30" },
  { value: 90, key: "lookback.days90" },
  { value: 365, key: "lookback.year1" },
  { value: null, key: "lookback.all" },
] as const;

type LocalizedError = { key: string; status?: number };

function errorDetails(cause: unknown, fallback: string): LocalizedError {
  if (cause instanceof MinifluxRequestError) return { key: "errors.minifluxRequest", status: cause.status };
  return { key: fallback };
}

function errorMessage(cause: unknown, t: TFunction, fallback: string) {
  const error = errorDetails(cause, fallback);
  return t(error.key, { status: error.status });
}

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

function safeHtml(html: string, minifluxURL: string, imageMode: ImageLoadingMode) {
  if (typeof window === "undefined") return "";
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script,style,object,embed,form,audio").forEach((node) => node.remove());
  parsed.querySelectorAll("iframe").forEach((frame) => {
    const src = youtubeEmbedURL(frame.getAttribute("src") ?? "");
    if (!src) {
      frame.remove();
      return;
    }
    frame.setAttribute("src", src);
    frame.setAttribute("loading", "eager");
    frame.setAttribute("referrerpolicy", imageReferrerPolicy(imageMode));
    frame.setAttribute("allow", "accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share");
    frame.setAttribute("allowfullscreen", "");
    if (!frame.getAttribute("title")) frame.setAttribute("title", "YouTube video player");
  });
  parsed.querySelectorAll("video").forEach((video) => {
    const src = articleMediaURL(video.getAttribute("src") ?? "", minifluxURL);
    if (src) video.setAttribute("src", src);
    else video.removeAttribute("src");

    video.querySelectorAll("source").forEach((source) => {
      const sourceSrc = articleMediaURL(source.getAttribute("src") ?? "", minifluxURL);
      if (!sourceSrc) source.remove();
      else source.setAttribute("src", sourceSrc);
    });
    video.querySelectorAll("track").forEach((track) => {
      const trackSrc = articleMediaURL(track.getAttribute("src") ?? "", minifluxURL);
      if (!trackSrc) track.remove();
      else track.setAttribute("src", trackSrc);
    });
    if (!src && !video.querySelector("source")) {
      video.remove();
      return;
    }

    video.setAttribute("referrerpolicy", imageReferrerPolicy(imageMode));
    const poster = articleMediaURL(video.getAttribute("poster") ?? "", minifluxURL);
    if (poster) {
      video.setAttribute("poster", imageURLForMode(poster, minifluxURL, imageMode));
    } else video.removeAttribute("poster");
    video.removeAttribute("autoplay");
    video.setAttribute("playsinline", "");
    video.setAttribute("preload", "metadata");
    if (src && isWeiboLivePhotoURL(src)) {
      video.removeAttribute("controls");
      video.removeAttribute("poster");
      video.setAttribute("muted", "");
      video.setAttribute("loop", "");
      video.setAttribute("preload", "auto");
      video.classList.add("articleLivePhoto");
      const frame = parsed.createElement("span");
      frame.className = "articleLivePhotoFrame";
      frame.setAttribute("role", "button");
      frame.setAttribute("tabindex", "0");
      frame.setAttribute("aria-label", "Live Photo");
      frame.setAttribute("aria-pressed", "false");
      const posterImage = poster ? parsed.createElement("img") : null;
      if (posterImage && poster) {
        frame.classList.add("hasPoster");
        posterImage.className = "articleLivePhotoPoster";
        posterImage.setAttribute("src", imageURLForMode(poster, minifluxURL, imageMode));
        posterImage.setAttribute("loading", "lazy");
        posterImage.setAttribute("referrerpolicy", "origin");
        posterImage.setAttribute("alt", "");
      }
      const badge = parsed.createElement("span");
      badge.className = "articleLivePhotoBadge";
      badge.setAttribute("aria-hidden", "true");
      badge.textContent = "● LIVE";
      video.replaceWith(frame);
      frame.append(...(posterImage ? [posterImage, video, badge] : [video, badge]));
    } else video.setAttribute("controls", "");
  });
  parsed.querySelectorAll("source,track").forEach((mediaChild) => {
    if (!mediaChild.closest("video")) mediaChild.remove();
  });
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
    const parentLink = image.parentElement?.tagName === "A" ? image.parentElement : null;
    if (parentLink?.children.length === 1 && parentLink.textContent?.trim()) {
      image.classList.add("articleInlineIcon");
    }
    const currentSrc = image.getAttribute("src") ?? "";
    const src = imageURLForMode(currentSrc, minifluxURL, imageMode);
    if (!/^https?:\/\//i.test(src)) image.remove();
    else {
      image.setAttribute("src", src);
      const srcset = image.getAttribute("srcset");
      if (srcset) {
        image.setAttribute("srcset", srcset.replace(
          /https?:\/\/[^\s,]+/gi,
          (candidate) => imageURLForMode(candidate, minifluxURL, imageMode),
        ));
      }
      image.setAttribute("loading", "lazy");
      image.setAttribute("referrerpolicy", imageReferrerPolicy(imageMode));
    }
  });
  return parsed.body.innerHTML;
}

function toggleLivePhoto(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  const frame = target.closest<HTMLElement>(".articleLivePhotoFrame");
  const video = frame?.querySelector("video");
  if (!frame || !video) return false;
  if (video.paused) {
    video.muted = true;
    void video.play().then(() => {
      frame.classList.add("playing");
      frame.setAttribute("aria-pressed", "true");
    }).catch(() => {
      frame.classList.remove("playing");
      frame.setAttribute("aria-pressed", "false");
    });
  } else {
    video.pause();
    frame.classList.remove("playing");
    frame.setAttribute("aria-pressed", "false");
  }
  return true;
}

const SourceIcon = ({ children, src }: { children: React.ReactNode; src?: string }) => (
  <span className={`sourceIcon ${src ? "hasImage" : ""}`}>
    {src ? <img src={src} alt="" /> : children}
  </span>
);

function ArticleMetadata({
  story,
  feedIcon,
  timeZone,
  initialReadingSeconds,
  onReadingTick,
  t,
}: {
  story: Story;
  feedIcon?: string;
  timeZone: string;
  initialReadingSeconds: number;
  onReadingTick: () => boolean;
  t: TFunction;
}) {
  const [readingSeconds, setReadingSeconds] = useState(initialReadingSeconds);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (onReadingTick()) setReadingSeconds((seconds) => seconds + 5);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [onReadingTick]);

  return <header className="articleHead"><div><h2>{story.title}</h2><p><SourceIcon src={feedIcon}>{story.mark}</SourceIcon>{story.author || story.source} · {formatZonedDateTime(story.published_at, timeZone)} · {t("feed.minutes", { count: story.reading_time || 1 })}{readingSeconds > 0 && <span className="articleReadingTime">· {Math.floor(readingSeconds / 60)}:{String(readingSeconds % 60).padStart(2, "0")}</span>}</p></div></header>;
}

const ArticleBody = memo(function ArticleBody({
  content,
  minifluxURL,
  imageMode,
}: {
  content: string;
  minifluxURL: string;
  imageMode: ImageLoadingMode;
}) {
  const markup = useMemo(() => ({
    __html: safeHtml(content, minifluxURL, imageMode),
  }), [content, minifluxURL, imageMode]);

  return <div className="body articleContent" onClick={(event) => toggleLivePhoto(event.target)} onKeyDown={(event) => {
    if ((event.key === "Enter" || event.key === " ") && toggleLivePhoto(event.target)) event.preventDefault();
  }} dangerouslySetInnerHTML={markup} />;
});

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
  imageProxyAvailable,
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
  onImageModeChange,
  onEventsChange,
  onDisconnect,
  onResetSync,
  syncBusy,
  notify,
}: {
  config: ConnectionConfig;
  feeds: Feed[];
  referrerScope: string;
  imageProxyAvailable: boolean;
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
  onImageModeChange: (feedId?: number) => void;
  onEventsChange: (events: ReadingEvent[]) => void;
  onDisconnect: () => void;
  onResetSync: () => Promise<void>;
  syncBusy: boolean;
  notify: (message: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<"general" | "sync" | "feeds" | "recommendation">("general");
  const [selectedFeedId, setSelectedFeedId] = useState<number | null>(null);
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
      if (!result.started) notify(t("settings.saving"));
      return result.started;
    } catch {
      notify(failure);
      return false;
    }
  };

  const setTheme = async (theme: ThemeName) => {
    await saveProfileChange(
      (current) => ({ ...current, theme, updatedAt: new Date().toISOString() }),
      t("settings.themeSaveFailed"),
    );
  };

  const setLanguage = async (language: SupportedLanguage) => {
    const saved = await saveProfileChange(
      (current) => ({ ...current, language, updatedAt: new Date().toISOString() }),
      t("settings.languageSaveFailed"),
    );
    if (saved) await i18n.changeLanguage(language);
  };

  const setDefaultImageMode = async (mode: ImageLoadingMode) => {
    if (!referrerScope) return;
    const saved = await saveProfileChange((current) => ({
      ...current,
      imageLoadingPreferences: updateDefaultImageLoadingMode(
        current.imageLoadingPreferences,
        referrerScope,
        mode,
      ),
      updatedAt: new Date().toISOString(),
    }), t("settings.imageSaveFailed"));
    if (saved) onImageModeChange();
  };

  const setFeedImageMode = async (feedId: number, value: string) => {
    if (!referrerScope) return;
    const mode = value === "inherit" ? null : value as ImageLoadingMode;
    const saved = await saveProfileChange((current) => ({
      ...current,
      imageLoadingPreferences: updateFeedImageLoadingMode(
        current.imageLoadingPreferences,
        referrerScope,
        feedId,
        mode,
      ),
      updatedAt: new Date().toISOString(),
    }), t("settings.imageSaveFailed"));
    if (saved) onImageModeChange(feedId);
  };

  const setEntryLookback = async (value: string) => {
    const entryLookbackDays = value === "all" ? null : Number(value);
    const saved = await saveProfileChange(
      (current) => ({ ...current, entryLookbackDays, updatedAt: new Date().toISOString() }),
      t("settings.lookbackSaveFailed"),
    );
    if (saved) notify(entryLookbackDays === null
      ? t("settings.lookbackAllSaved")
      : t("settings.lookbackDaysSaved", { count: entryLookbackDays }));
  };

  const resetSync = async () => {
    if (!window.confirm(t("sync.resetConfirm"))) return;
    setResetting(true);
    try {
      await onResetSync();
    } finally {
      setResetting(false);
    }
  };

  const saveEvent = async () => {
    if (!draft || !draft.title.trim() || !draft.source.trim()) {
      notify(t("recommendation.missingFields"));
      return;
    }
    const openedAt = normalizeReadingEventOpenedAt(draft.openedAt);
    if (!openedAt) {
      notify(t("recommendation.invalidOpenedAt"));
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
    notify(draft.id ? t("recommendation.eventUpdated") : t("recommendation.eventAdded"));
  };

  const removeEvent = async (event: ReadingEvent) => {
    if (!window.confirm(t("recommendation.deleteConfirm", { title: event.title }))) return;
    await deleteReadingEvent(event.id);
    onEventsChange(events.filter((item) => item.id !== event.id));
    if (draft?.id === event.id) setDraft(null);
    notify(t("recommendation.eventDeleted"));
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
  feeds.forEach((feed) => sourceName.set(feed.id, feed.title));
  const topSources = [...sourceWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const topWords = [...wordWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const topNegatives = [...negativeWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const shownEvents = [...events]
    .filter((event) => !eventQuery.trim() || `${event.title} ${event.source} ${event.terms.join(" ")}`.toLowerCase().includes(eventQuery.trim().toLowerCase()))
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  const sortedFeeds = [...feeds]
    .sort((a, b) => `${a.category?.title ?? ""}\n${a.title}`.localeCompare(`${b.category?.title ?? ""}\n${b.title}`, i18n.resolvedLanguage ?? "en"));
  const selectedFeed = sortedFeeds.find((feed) => feed.id === selectedFeedId) ?? sortedFeeds[0] ?? null;

  return (
    <div className="settingsBackdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="settingsDialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header>
          <div><small>{t("settings.eyebrow")}</small><h2 id="settings-title">{t("settings.title")}</h2></div>
          <button onClick={onClose} aria-label={t("settings.close")}>×</button>
        </header>
        <nav className="settingsTabs" aria-label={t("settings.categories")}>
          <button className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>{t("settings.general")}</button>
          <button className={tab === "sync" ? "active" : ""} onClick={() => setTab("sync")}>{t("settings.sync")}</button>
          <button className={tab === "feeds" ? "active" : ""} onClick={() => setTab("feeds")}>{t("settings.feeds")}</button>
          <button className={tab === "recommendation" ? "active" : ""} onClick={() => setTab("recommendation")}>{t("settings.recommendation")} <span>{events.length}</span></button>
        </nav>

        <div className="settingsDialogBody">
          {tab === "general" && <>
            <section>
              <div className="settingTitle"><div><h3>{t("theme.appearance")}</h3><p>{t("theme.description")}</p></div></div>
              <div className="themeGrid">
                {(["day", "night"] as ThemeName[]).map((theme) => (
                  <button key={theme} disabled={profileSaving} className={settings.theme === theme ? "themeCard selected" : "themeCard"} onClick={() => void setTheme(theme)}>
                    <i className={`themeSwatch ${theme}`}><b /><b /><b /></i>
                    <strong>{t(`theme.${theme}`)}</strong>
                    <small>{t(`theme.${theme}Hint`)}</small>
                  </button>
                ))}
              </div>
            </section>
            <section>
              <div className="settingTitle"><div><h3>{t("language.label")}</h3><p>{t("language.description")}</p></div></div>
              <div className="settingsForm">
                <label>
                  <span>{t("language.label")}</span>
                  <select disabled={profileSaving} value={settings.language ?? i18n.resolvedLanguage ?? "en"} onChange={(event) => void setLanguage(event.target.value as SupportedLanguage)}>
                    {SUPPORTED_LANGUAGES.map((language) => <option key={language} value={language}>{t(`language.${language}`)}</option>)}
                  </select>
                </label>
              </div>
            </section>
            <section className="privacyBox">
              <strong>{t("settings.localBoundary")}</strong>
              <p>{t("settings.localBoundaryHint")}</p>
            </section>
          </>}

          {tab === "sync" && <>
            <section>
              <div className="settingTitle">
                <div><h3>{t("sync.title")}</h3><p>{t("sync.description")}</p></div>
                <span>{t("sync.connected")}</span>
              </div>
              <div className="settingsForm minifluxSettings">
                <label><span>{t("sync.server")}</span><input value={config.url} readOnly /></label>
                <label className="timeZoneSetting"><span>{t("sync.timeZone")}</span><input value={timeZone} readOnly /><small>{t(timeZoneSource === "miniflux" ? "sync.timeZoneMinifluxHint" : "sync.timeZoneBrowserHint")}</small></label>
                <label className="syncSelectSetting">
                  <span>{t("sync.range")}</span>
                  <select disabled={profileSaving} value={settings.entryLookbackDays ?? "all"} onChange={(event) => void setEntryLookback(event.target.value)}>
                    {LOOKBACK_OPTIONS.map((option) => <option key={option.value ?? "all"} value={option.value ?? "all"}>{t(option.key)}</option>)}
                  </select>
                  <small>{t("sync.rangeHint")}</small>
                </label>
                <label className="syncSelectSetting imageDefaultMode">
                  <span>{t("settings.imageDefault")}</span>
                  <select
                    disabled={profileSaving || !referrerScope}
                    value={settings.imageLoadingPreferences[referrerScope]?.defaultMode === "proxy" && !imageProxyAvailable
                      ? "direct-no-referrer"
                      : settings.imageLoadingPreferences[referrerScope]?.defaultMode ?? "direct-no-referrer"}
                    onChange={(event) => void setDefaultImageMode(event.target.value as ImageLoadingMode)}
                  >
                    <option value="direct-no-referrer">{t("settings.imageModeDirectNoReferrer")}</option>
                    <option value="direct-origin">{t("settings.imageModeDirectOrigin")}</option>
                    {imageProxyAvailable && <option value="proxy">{t("settings.imageModeProxy")}</option>}
                  </select>
                  <small>{imageProxyAvailable ? t("settings.imageDefaultHint") : t("settings.imageProxyUnavailable")}</small>
                </label>
                <div className="syncDataActions">
                  <div><strong>{t("sync.resetTitle")}</strong><p>{t("sync.resetHint")}</p></div>
                  <button className="dangerAction" disabled={syncBusy || resetting} onClick={() => void resetSync()}>{resetting ? t("sync.resetting") : t("sync.resetData")}</button>
                </div>
                <button className="disconnect" disabled={profileSaving} onClick={onDisconnect}>{t("sync.disconnect")}</button>
              </div>
            </section>
          </>}

          {tab === "feeds" && <section className="feedSettingsSection">
            <div className="settingTitle"><div><h3>{t("settings.feedSettingsTitle")}</h3><p>{t("settings.feedSettingsHint")}</p></div></div>
            {selectedFeed && referrerScope ? <div className="feedSettingsLayout">
              <nav className="feedSettingsNav" aria-label={t("settings.feedList")}>
                {sortedFeeds.map((feed) => <button
                  key={feed.id}
                  type="button"
                  className={feed.id === selectedFeed.id ? "selected" : ""}
                  aria-current={feed.id === selectedFeed.id ? "true" : undefined}
                  onClick={() => setSelectedFeedId(feed.id)}
                >
                  <SourceIcon>{feed.title.slice(0, 1).toUpperCase()}</SourceIcon>
                  <span><strong>{feed.title}</strong><small>{feed.category?.title ?? t("settings.uncategorized")}</small></span>
                </button>)}
              </nav>
              <div className="feedSettingsInspector">
                <header>
                  <SourceIcon>{selectedFeed.title.slice(0, 1).toUpperCase()}</SourceIcon>
                  <div><h3>{selectedFeed.title}</h3><p>{selectedFeed.category?.title ?? t("settings.uncategorized")}</p></div>
                </header>
                <section>
                  <div className="settingTitle"><div><h3>{t("settings.imageCompatibility")}</h3><p>{t("settings.imageCompatibilityHint")}</p></div></div>
                  <label className="feedSettingRow">
                    <span>{t("settings.imageLoading")}</span>
                    <select
                      disabled={profileSaving}
                      value={settings.imageLoadingPreferences[referrerScope]?.feedModes[String(selectedFeed.id)] === "proxy" && !imageProxyAvailable
                        ? "inherit"
                        : settings.imageLoadingPreferences[referrerScope]?.feedModes[String(selectedFeed.id)] ?? "inherit"}
                      onChange={(event) => void setFeedImageMode(selectedFeed.id, event.target.value)}
                    >
                      <option value="inherit">{t("settings.imageModeInherit")}</option>
                      <option value="direct-no-referrer">{t("settings.imageModeDirectNoReferrer")}</option>
                      <option value="direct-origin">{t("settings.imageModeDirectOrigin")}</option>
                      {imageProxyAvailable && <option value="proxy">{t("settings.imageModeProxy")}</option>}
                    </select>
                  </label>
                </section>
              </div>
            </div> : <p className="feedSettingsEmpty">{feeds.length ? t("settings.preparingFeeds") : t("settings.noFeeds")}</p>}
          </section>}

          {tab === "recommendation" && <div className="recommendationData">
            <section className="dataIntro">
              <div><h3>{t("recommendation.title")}</h3><p>{t("recommendation.description")}</p></div>
              <button className="primaryAction" onClick={() => setDraft(emptyEventDraft())}>{t("recommendation.addRecord")}</button>
            </section>
            <section className="metricGrid">
              <div><strong>{events.length}</strong><span>{t("recommendation.readingEvents")}</span></div>
              <div><strong>{validEvents.length}</strong><span>{t("recommendation.validEvents")}</span></div>
              <div><strong>{t("common.secondsShort", { count: averageSeconds })}</strong><span>{t("recommendation.averageForeground")}</span></div>
              <div><strong>{t("common.percent", { count: averageDepth })}</strong><span>{t("recommendation.averageDepth")}</span></div>
              <div><strong>{helpfulCount}</strong><span>{t("recommendation.helpfulQuoted")}</span></div>
              <div><strong>{negativeCount}</strong><span>{t("recommendation.notInterestedQuoted")}</span></div>
              <div><strong>{starredCount}</strong><span>{t("recommendation.saved")}</span></div>
            </section>
            <section className="derivedData">
              <div>
                <header><h3>{t("recommendation.sourceWeights")}</h3><small>{t("recommendation.sourceWeightsHint")}</small></header>
                <div className="weightList">{topSources.length ? topSources.map(([feedId, weight]) => <span key={feedId}><b>{sourceName.get(feedId) ?? `${t("common.feed")} ${feedId}`}</b><em>{weight.toFixed(2)}</em></span>) : <p>{t("recommendation.noWeights")}</p>}</div>
              </div>
              <div>
                <header><h3>{t("recommendation.positiveTerms")}</h3><small>{t("recommendation.positiveTermsHint")}</small></header>
                <div className="weightTags">{topWords.length ? topWords.map(([word, weight]) => <span key={word}>{word}<em>{weight.toFixed(1)}</em></span>) : <p>{t("recommendation.noKeywords")}</p>}</div>
              </div>
              <div>
                <header><h3>{t("recommendation.negativeTerms")}</h3><small>{t("recommendation.negativeTermsHint")}</small></header>
                <div className="weightTags negative">{topNegatives.length ? topNegatives.map(([word, weight]) => <span key={word}>{word}<em>{weight.toFixed(1)}</em></span>) : <p>{t("recommendation.noNegativeTerms")}</p>}</div>
              </div>
            </section>

            {draft && <section className="eventEditor">
              <header><div><h3>{draft.id ? t("recommendation.editEvent") : t("recommendation.addEvent")}</h3><small>{t("recommendation.editorHint")}</small></div><button onClick={() => setDraft(null)} aria-label={t("common.close")}>×</button></header>
              <div className="eventForm">
                <label className="wide"><span>{t("recommendation.articleTitle")}</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
                <label><span>{t("recommendation.source")}</span><input value={draft.source} onChange={(event) => setDraft({ ...draft, source: event.target.value })} /></label>
                <label><span>{t("recommendation.openedAt")}</span><input type="datetime-local" value={draft.openedAt ? toZonedDateTimeInput(draft.openedAt, timeZone) : ""} onChange={(event) => setDraft({ ...draft, openedAt: event.target.value ? zonedDateTimeInputToIso(event.target.value, timeZone, draft.openedAt) : "" })} /></label>
                <label><span>{t("recommendation.entryId")}</span><input type="number" value={draft.entryId} onChange={(event) => setDraft({ ...draft, entryId: Number(event.target.value) })} /></label>
                <label><span>{t("recommendation.feedId")}</span><input type="number" value={draft.feedId} onChange={(event) => setDraft({ ...draft, feedId: Number(event.target.value) })} /></label>
                <label><span>{t("recommendation.foregroundSeconds")}</span><input type="number" min="0" value={draft.activeSeconds} onChange={(event) => setDraft({ ...draft, activeSeconds: Number(event.target.value) })} /></label>
                <label><span>{t("recommendation.scrollDepth")}</span><input type="number" min="0" max="1" step=".01" value={draft.scrollDepth} onChange={(event) => setDraft({ ...draft, scrollDepth: Number(event.target.value) })} /></label>
                <label><span>{t("recommendation.origin")}</span><select value={draft.origin} onChange={(event) => setDraft({ ...draft, origin: event.target.value as ReadingEvent["origin"] })}><option value="recommendation">{t("recommendation.originRecommendation")}</option><option value="feed">{t("recommendation.originFeed")}</option><option value="search">{t("recommendation.originSearch")}</option><option value="saved">{t("recommendation.originSaved")}</option></select></label>
                <label><span>{t("recommendation.feedback")}</span><select value={draft.feedback ?? ""} onChange={(event) => setDraft({ ...draft, feedback: event.target.value ? event.target.value as ReadingEvent["feedback"] : undefined })}><option value="">{t("common.none")}</option><option value="helpful">{t("recommendation.helpful")}</option><option value="not_interested">{t("recommendation.notInterested")}</option></select></label>
                <label className="wide"><span>{t("recommendation.keywords")}</span><input value={draft.terms.join(", ")} onChange={(event) => setDraft({ ...draft, terms: event.target.value.split(",") })} /></label>
              </div>
              <footer><button onClick={() => setDraft(null)}>{t("common.cancel")}</button><button className="primaryAction" onClick={() => void saveEvent()}>{t("recommendation.saveRecord")}</button></footer>
            </section>}

            <section className="eventRecords">
              <header><div><h3>{t("recommendation.rawEvents")}</h3><small>{t("recommendation.rawEventsSummary", { shown: shownEvents.length, total: events.length })}</small></div><input value={eventQuery} onChange={(event) => setEventQuery(event.target.value)} placeholder={t("recommendation.searchPlaceholder")} /></header>
              <div className="eventTable">
                <div className="eventTableHead"><span>{t("recommendation.articleSource")}</span><span>{t("recommendation.behavior")}</span><span>{t("recommendation.signal")}</span><span /></div>
                {shownEvents.length ? shownEvents.map((event) => <div className="eventRow" key={event.id}>
                  <span><strong>{event.title}</strong><small>{event.source} · {formatZonedDateTime(event.openedAt, timeZone)}</small></span>
                  <span><b>{t("common.secondsShort", { count: Math.round(event.activeSeconds) })}</b><small>{t("recommendation.scrollSummary", { depth: Math.round(event.scrollDepth * 100), origin: t(`recommendation.origin${event.origin[0].toUpperCase()}${event.origin.slice(1)}`) })}</small></span>
                  <span><b>{event.feedback === "helpful" ? t("recommendation.helpful") : event.feedback === "not_interested" ? t("recommendation.notInterested") : t("recommendation.implicit")}</b><small>{event.terms.slice(0, 4).join(" · ") || t("recommendation.noTerms")}</small></span>
                  <span><button onClick={() => setDraft({ ...event })}>{t("common.edit")}</button><button className="danger" onClick={() => void removeEvent(event)}>{t("common.delete")}</button></span>
                </div>) : <p className="noEvents">{t("recommendation.noMatchingEvents")}</p>}
              </div>
            </section>
          </div>}
        </div>
      </section>
    </div>
  );
}

function ConnectScreen({ onConnected }: { onConnected: (config: ConnectionConfig, settings: ProfileSettings) => void }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [remember, setRemember] = useState(true);
  const [entryLookbackDays, setEntryLookbackDays] = useState<number | null>(DEFAULT_LOOKBACK_DAYS);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<LocalizedError | null>(null);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    const config = { url: url.trim().replace(/\/+$/, ""), apiKey: apiKey.trim(), remember };
    setTesting(true);
    setError(null);
    try {
      await minifluxFetch(config, "/v1/me");
      saveConnection(config);
      const currentSettings = await getProfileSettings();
      const nextSettings = { ...currentSettings, entryLookbackDays, updatedAt: new Date().toISOString() };
      await saveProfileSettings(nextSettings);
      onConnected(config, nextSettings);
    } catch (cause) {
      setError(cause instanceof TypeError
        ? { key: "connect.directFailed" }
        : errorDetails(cause, "connect.failed"));
    } finally {
      setTesting(false);
    }
  };

  return (
    <main className="onboarding" data-theme="day">
      <div className="onboardGlow" />
      <section className="connectCard">
        <div className="connectBrand"><span className="wave">▁▅█▃▇▂</span><strong>READFLUX</strong><small>{t("connect.tagline")}</small></div>
        <p className="eyebrow">{t("connect.eyebrow")}</p>
        <h1>{t("connect.headline").split("\n").map((line, index) => <span key={line}>{index > 0 && <br />}{line}</span>)}</h1>
        <p className="connectLead">{t("connect.lead")}</p>
        <form onSubmit={connect}>
          <label><span>{t("connect.url")}</span><input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://rss.example.com" autoComplete="url" /></label>
          <label><span>{t("connect.apiKey")}</span><input type="password" required value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={t("connect.apiKeyPlaceholder")} autoComplete="off" /></label>
          <label className="connectLookback"><span>{t("connect.initialLoad")}</span><select value={entryLookbackDays ?? "all"} onChange={(event) => setEntryLookbackDays(event.target.value === "all" ? null : Number(event.target.value))}>{LOOKBACK_OPTIONS.map((option) => <option key={option.value ?? "all"} value={option.value ?? "all"}>{t(option.key)}</option>)}</select><small>{t("connect.savedAllHistory")}</small></label>
          <label className="remember"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /><span>{t("connect.remember")}</span><small>{remember ? t("connect.storedBrowser") : t("connect.clearedTab")}</small></label>
          {error && <p className="formError">{t(error.key, { status: error.status })}</p>}
          <button className="connectButton" disabled={testing}>{testing ? t("connect.testing") : t("connect.submit")}</button>
        </form>
        <footer><span>{t("connect.noServer")}</span><span>{t("connect.keyBoundary")}</span></footer>
      </section>
      <aside className="connectAside">
        <div className="miniSignal"><i /><span>{t("connect.signalBasis")}</span><strong>{t("connect.realReading")}</strong></div>
        <div className="miniSignal"><i /><span>{t("connect.localProfile")}</span><strong>IndexedDB</strong></div>
        <div className="miniSignal"><i /><span>{t("connect.dataBoundary")}</span><strong>{t("connect.thisDevice")}</strong></div>
      </aside>
    </main>
  );
}

export default function App() {
  const { t, i18n } = useTranslation();
  const [config, setConfig] = useState<ConnectionConfig | null>(null);
  const [ready, setReady] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [events, setEvents] = useState<ReadingEvent[]>([]);
  const [settings, setSettings] = useState<ProfileSettings>({ theme: "day", entryLookbackDays: DEFAULT_LOOKBACK_DAYS, imageLoadingPreferences: {}, updatedAt: new Date(0).toISOString() });
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
  const [markAllReadOpen, setMarkAllReadOpen] = useState(false);
  const [markAllReadPosition, setMarkAllReadPosition] = useState({ top: 0, left: 0, arrowLeft: 0 });
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
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [contentLoadingId, setContentLoadingId] = useState<number | null>(null);
  const [contentError, setContentError] = useState<{ id: number; error: LocalizedError } | null>(null);
  const [error, setError] = useState<LocalizedError | null>(null);
  const [pendingNew, setPendingNew] = useState(0);
  const [entryLabels, setEntryLabels] = useState<Map<number, string[]>>(new Map());
  const [visibleIds, setVisibleIds] = useState<number[]>([]);
  const [referrerScopeState, setReferrerScopeState] = useState({ url: "", scope: "" });
  const [imageProxySupport, setImageProxySupport] = useState({ url: "", available: false });
  const activeEvent = useRef<ReadingEvent | null>(null);
  const readerRef = useRef<HTMLDivElement | null>(null);
  const markAllReadButtonRef = useRef<HTMLButtonElement | null>(null);
  const markAllReadConfirmRef = useRef<HTMLButtonElement | null>(null);
  const refreshInFlight = useRef(false);
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
  const loadRef = useRef<(options?: { background?: boolean }) => Promise<boolean>>(async () => false);
  const proxyRefreshKey = useRef("");

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
  const imageProxyAvailable = Boolean(config
    && imageProxySupport.url === config.url
    && imageProxySupport.available);

  useEffect(() => {
    Promise.all([getReadingEvents(), getProfileSettings()]).then(async ([history, profile]) => {
      if (profile.language) await i18n.changeLanguage(profile.language);
      setEvents(history);
      setSettings(profile);
      setConfig(getConnection());
      setReady(true);
    });
  }, [i18n]);

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
    const refreshSettings = () => { void getProfileSettings().then((profile) => {
      setSettings(profile);
      if (profile.language) void i18n.changeLanguage(profile.language);
    }); };
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
  }, [i18n]);

  const mergeEntryBatch = useCallback(async (batch: Entry[]) => {
    if (!config || !batch.length) return;
    if (batch.some((entry) => containsMinifluxProxyURL(entry.content, config.url))) {
      setImageProxySupport({ url: config.url, available: true });
    }
    const updatedIds = new Set<number>();
    setEntries((current) => {
      const merged = new Map(current.map((entry) => [entry.id, entry]));
      batch.forEach((entry) => {
        const cached = merged.get(entry.id);
        if (cached && cached.status === "read" && entry.changed_at && cached.changed_at
          && entry.changed_at > cached.changed_at) {
          updatedIds.add(entry.id);
        }
        merged.set(entry.id, {
          ...cached,
          ...entry,
          content: entry.content || cached?.content || "",
        });
      });
      return [...merged.values()];
    });
    if (updatedIds.size) {
      try {
        await Promise.all([...updatedIds].map((id) => addEntryLabel(config, id, "updated")));
      } catch { /* label persistence is best-effort */ }
      setEntryLabels((current) => {
        const next = new Map(current);
        updatedIds.forEach((id) => {
          const labels = next.get(id) ?? [];
          if (!labels.includes("updated")) next.set(id, [...labels, "updated"]);
        });
        return next;
      });
    }
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
      const updatedInList = batch.filter((entry) => {
        if (!updatedIds.has(entry.id)) return false;
        if (!listSnapshotIds.current.has(entry.id)) return false;
        if (!currentTopic && !isEntryInSmartFeed(entry, currentMode, todayKeyRef.current, timeZoneRef.current)) return false;
        if (currentHideRead && entry.status === "read") return false;
        if (currentTopic?.kind === "category") {
          const feed = feedsRef.current.find((f) => f.id === entry.feed_id);
          if (feed?.category?.id !== currentTopic.id) return false;
        }
        if (currentTopic?.kind === "feed" && entry.feed_id !== currentTopic.id) return false;
        return true;
      });
      const pending = relevant.length + updatedInList.length;
      if (pending) {
        if (visibleEmptyRef.current) {
          setListReadSnapshot((current) => {
            const next = new Map(current);
            relevant.forEach((entry) => next.set(entry.id, entry.status));
            return next;
          });
        } else {
          setPendingNew((n) => n + pending);
        }
      }
    }
    await putCachedEntries(config, batch);
  }, [config]);

  const lookbackDays = settings.entryLookbackDays === undefined
    ? DEFAULT_LOOKBACK_DAYS
    : settings.entryLookbackDays;

  const load = useCallback(async (options?: { background?: boolean }) => {
    if (!config) return false;
    if (syncResetInProgress.current || syncInFlight.current) {
      syncQueued.current = true;
      return false;
    }
    const background = options?.background ?? false;
    syncInFlight.current = true;
    setLoading(true);
    setError(null);
    const syncStartedAt = new Date().toISOString();
    try {
      startOptionalMinifluxTimeZoneLoad(
        () => minifluxFetch<MinifluxUser>(config, "/v1/me"),
        setMinifluxTimeZone,
      );
      const [cached, storedState, labels] = await Promise.all([
        getCachedEntries<Entry>(config),
        getEntrySyncState(config),
        getEntryLabels(config),
      ]);
      setEntryLabels(labels);
      const cutoff = lookbackDays === null
        ? null
        : Date.now() - lookbackDays * 86_400_000;
      const scopedCache = cached.filter((entry) =>
        entry.starred || cutoff === null || new Date(entry.published_at).getTime() >= cutoff);
      setEntries(scopedCache);
      setImageProxySupport({ url: config.url, available: false });
      if (!listSnapshotIds.current.size || !scopedCache.some((e) => listSnapshotIds.current.has(e.id))) {
        setListReadSnapshot(new Map(scopedCache.map((entry) => [entry.id, entry.status])));
      }
      const [feedData, categoryData, proxyProbe] = await Promise.all([
        minifluxFetch<Feed[]>(config, "/v1/feeds"),
        minifluxFetch<Category[]>(config, "/v1/categories"),
        minifluxFetch<EntryPage>(config, "/v1/entries?limit=20&order=published_at&direction=desc")
          .catch(() => null),
      ]);
      setFeeds(feedData ?? []);
      setCategories(categoryData ?? []);
      const proxyAvailable = detectMinifluxProxySupport(proxyProbe?.entries ?? [], config.url);
      setImageProxySupport({ url: config.url, available: proxyAvailable });
      if (proxyAvailable && proxyProbe) {
        await mergeEntryBatch(proxyProbe.entries);
      }
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
      return true;
    } catch (cause) {
      setError(cause instanceof TypeError
        ? { key: "connect.directFailed" }
        : errorDetails(cause, "errors.connect"));
      return false;
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
      if (document.visibilityState === "visible" && !refreshInFlight.current) void loadRef.current({ background: true });
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
    const source = feed?.title ?? t("feed.unknownSource");
    const category = feed?.category?.title ?? t("settings.uncategorized");
    const titleTerms = termsOf(`${entry.title} ${toText(entry.content).slice(0, 240)}`);
    const hits = titleTerms.map((word) => [word, interest.words.get(word) ?? 0] as const).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
    const negative = titleTerms.reduce((sum, word) => sum + (interest.negatives.get(word) ?? 0), 0);
    const sourceAffinity = interest.sources.get(entry.feed_id) ?? 0;
    const ageDays = Math.max(0, ((syncedAt?.getTime() ?? 0) - new Date(entry.published_at).getTime()) / 86_400_000);
    const freshness = Math.max(0, 12 - Math.floor(ageDays));
    const score = Math.max(1, Math.min(99, Math.round(44 + Math.min(25, sourceAffinity * 3) + Math.min(20, hits.reduce((sum, [, value]) => sum + value, 0)) + freshness + (entry.starred ? 8 : 0) - negative * 2)));
    const terms = hits.slice(0, 2).map(([word]) => word).join(", ");
    const reason = sourceAffinity >= 2
      ? t("recommendation.reasonSource", { source, interest: hits[0] ? t("recommendation.reasonSourceInterest", { terms }) : "" })
      : hits[0]
        ? t("recommendation.reasonTerms", { terms })
        : entry.starred
          ? t("recommendation.reasonSaved")
          : events.length
            ? t("recommendation.reasonCategory", { category })
            : t("recommendation.reasonNew");
    const summary = toText(entry.content).slice(0, 160);
    return {
      ...entry,
      source,
      category,
      categoryId: feed?.category?.id,
      mark: source.trim().slice(0, 1).toUpperCase() || "·",
      summary: summary ? `${summary}${summary.length >= 160 ? "…" : ""}` : t("feed.noSummary"),
      score,
      reason,
    };
  }), [entries, events.length, feedMap, interest, syncedAt, t]);

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
        return compareSmartFeedEntries(a, b, topic ? "unread" : mode, entryLabels);
      });
    } else {
      filtered.sort((a, b) => compareSmartFeedEntries(a, b, topic ? "unread" : mode, entryLabels));
    }
    return filtered;
  }, [stories, mode, topic, query, hideRead, listReadSnapshot, visibleIds, todayKey, activeTimeZone, entryLabels]);
  const visibleUnreadCount = useMemo(
    () => visible.reduce((count, story) => count + (story.status === "unread" ? 1 : 0), 0),
    [visible],
  );

  useEffect(() => {
    if (visible.length && !visibleIds.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- captures sort order after fresh sort
      setVisibleIds(visible.map((s) => s.id));
    }
  }, [visible, visibleIds]);

  useEffect(() => { visibleEmptyRef.current = !visible.length; }, [visible]);

  const selected = stories.find((story) => story.id === selectedId) ?? null;
  const selectedReadingSeconds = selected
    ? events.reduce((sum, event) => event.entryId === selected.id ? sum + event.activeSeconds : sum, 0)
    : 0;
  const selectedImageMode = selected
    ? resolveImageLoadingMode(
        settings.imageLoadingPreferences,
        referrerScope,
        selected.feed_id,
        imageProxyAvailable,
      )
    : "direct-no-referrer";

  const recordReadingTick = useCallback(() => {
    if (!activeEvent.current || document.visibilityState !== "visible" || !document.hasFocus()) return false;
    if (document.querySelector("[aria-modal='true']")) return false;
    activeEvent.current.activeSeconds += 5;
    void persistActive();
    return true;
  }, [persistActive]);

  useEffect(() => {
    const flush = () => { commitActiveEvent(); void persistActive(); };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); commitActiveEvent(); void persistActive(); };
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
      notify(errorMessage(cause, t, "errors.sync"));
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
        error: errorDetails(cause, "reader.contentFailed"),
      });
    } finally {
      setContentLoadingId((current) => current === id ? null : current);
    }
  }, [config, entries]);

  useEffect(() => {
    if (!config || !selected || selectedImageMode !== "proxy") {
      proxyRefreshKey.current = "";
      return;
    }
    const refreshKey = `${config.url}:${selected.id}`;
    const alreadyAttempted = proxyRefreshKey.current === refreshKey;
    if (!shouldRefreshProxyContent(selected.content, config.url, selectedImageMode, alreadyAttempted)) return;
    proxyRefreshKey.current = refreshKey;
    void loadEntryContent(selected.id);
  }, [config, selected, selectedImageMode, loadEntryContent]);

  const choose = useCallback((story: Story, origin?: ReadingEvent["origin"]) => {
    commitActiveEvent();
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
      readingTime: story.reading_time,
      listPosition: (() => { const i = visible.findIndex((s) => s.id === story.id); return i >= 0 ? i : undefined; })(),
    });
    void putReadingEvent(activeEvent.current);
    if (config && entryLabels.get(story.id)?.includes("updated")) {
      void removeEntryLabel(config, story.id, "updated");
      setEntryLabels((current) => {
        const next = new Map(current);
        const labels = (next.get(story.id) ?? []).filter((l) => l !== "updated");
        if (labels.length) next.set(story.id, labels);
        else next.delete(story.id);
        return next;
      });
    }
    if (story.status === "unread" && config) {
      void updateEntry(story.id, { status: "read" }, () => minifluxFetch(config, "/v1/entries", {
        method: "PUT",
        body: JSON.stringify({ entry_ids: [story.id], status: "read" }),
      }), t("reader.markedRead"));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, mode, query, visible, persistActive, commitActiveEvent, loadEntryContent, entryLabels, t]);

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
    }), status === "read" ? t("reader.markedRead") : t("reader.markedUnread"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, entries, t]);

  const markVisibleRead = useCallback(async () => {
    if (!config) return;
    const ids = visible.filter((story) => story.status === "unread").map((story) => story.id);
    if (!ids.length) return notify(t("feed.noUnread"));
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
      notify(t("feed.markedRead", { count: ids.length }));
    } catch (cause) {
      setEntries(before);
      setVisibleIds([]);
      setListReadSnapshot(new Map(before.map((entry) => [entry.id, entry.status])));
      notify(errorMessage(cause, t, "errors.sync"));
    }
  }, [config, entries, notify, t, visible]);

  const positionMarkAllRead = useCallback(() => {
    const trigger = markAllReadButtonRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(273, window.innerWidth - 24);
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width));
    const top = rect.bottom + 10;
    setMarkAllReadPosition({
      top,
      left,
      arrowLeft: Math.max(18, Math.min(width - 18, rect.left + rect.width / 2 - left)),
    });
  }, []);

  const requestMarkVisibleRead = useCallback(() => {
    if (!visibleUnreadCount) return notify(t("feed.noUnread"));
    positionMarkAllRead();
    setMarkAllReadOpen(true);
  }, [notify, positionMarkAllRead, t, visibleUnreadCount]);

  const dismissMarkAllRead = useCallback(() => {
    setMarkAllReadOpen(false);
    window.requestAnimationFrame(() => markAllReadButtonRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!markAllReadOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismissMarkAllRead();
    };
    const handleResize = () => positionMarkAllRead();
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);
    window.requestAnimationFrame(() => markAllReadConfirmRef.current?.focus());
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleResize);
    };
  }, [dismissMarkAllRead, markAllReadOpen, positionMarkAllRead]);

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
      if (settingsOpen || markAllReadOpen) return;
      if (["INPUT", "TEXTAREA"].includes((event.target as HTMLElement).tagName)) return;
      if (event.key.toLowerCase() === "j" || event.key === "ArrowDown") move(1);
      if (event.key.toLowerCase() === "k" || event.key === "ArrowUp") move(-1);
      if (event.key.toLowerCase() === "n") {
        const current = visible.findIndex((story) => story.id === selectedId);
        const nextUnread = [...visible.slice(current + 1), ...visible.slice(0, current + 1)].find((story) => story.status === "unread");
        if (nextUnread) choose(nextUnread);
      }
      if (!selected || !config) return;
      if (event.key.toLowerCase() === "s") void updateEntry(selected.id, { starred: !selected.starred }, () => minifluxFetch(config, `/v1/entries/${selected.id}/bookmark`, { method: "PUT" }), selected.starred ? t("reader.unsaved") : t("reader.saved"));
      if (["m", "u", "r"].includes(event.key.toLowerCase())) toggleRead(selected);
      if (event.key === "Enter") window.open(selected.url, "_blank", "noopener,noreferrer");
      if (event.key === " ") {
        event.preventDefault();
        const reader = readerRef.current;
        if (reader && reader.scrollTop + reader.clientHeight < reader.scrollHeight - 12) reader.scrollBy({ top: reader.clientHeight * .8, behavior: "smooth" });
        else move(1);
      }
      if (event.shiftKey && event.key.toLowerCase() === "a") requestMarkVisibleRead();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, move, selected, entries, visible, selectedId, choose, toggleRead, markAllReadOpen, requestMarkVisibleRead, settingsOpen]);

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
      notify(t("recommendation.reduced"));
    } else {
      notify(t("recommendation.reinforced"));
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
  const { unreadCount, todayCount, savedCount } = useMemo(
    () => countSmartFeedEntries(entries, todayKey, activeTimeZone),
    [entries, todayKey, activeTimeZone],
  );
  const syncProgressLabel = syncProgress
    ? `${syncProgress.kind === "initial"
      ? t(syncProgress.phase === "unread" ? "sync.initialUnread" : syncProgress.phase === "starred" ? "sync.initialSaved" : "sync.initialRead")
      : t(syncProgress.kind === "search" ? "sync.searching" : "sync.latest")}${syncProgress.total ? ` ${syncProgress.loaded} / ${syncProgress.total}` : ""}`
    : "";
  if (!ready) return <main className="boot" data-theme="day"><span className="wave">▁▅█▃▇▂</span><p>{t("connect.booting")}</p></main>;
  if (!config) return <ConnectScreen onConnected={(nextConfig, nextSettings) => {
    setSettings(nextSettings);
    setConfig(nextConfig);
  }} />;

  const refreshBusy = refreshing || loading;
  const refreshStatus = refreshFailed || error
    ? t("sync.failed")
    : syncProgress
      ? syncProgressLabel
      : refreshing
        ? t("sync.latest")
        : syncedAt
          ? t("feed.syncedAt", { time: formatZonedTime(syncedAt, activeTimeZone) })
          : t("sync.refresh");
  const refreshFeeds = async () => {
    if (refreshInFlight.current || loading) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      await minifluxFetch(config, "/v1/feeds/refresh", { method: "PUT" });
      const syncSucceeded = await load();
      if (!syncSucceeded) {
        setRefreshFailed(true);
        return;
      }
      refreshList();
      notify(t("sync.refreshDone"));
    } catch (cause) {
      setRefreshFailed(true);
      notify(errorMessage(cause, t, "sync.refreshFailed"));
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  };

  const nav = [
    ["today", "bi-brightness-high-fill", t("sidebar.today"), todayCount],
    ["unread", "bi-circle-fill", t("sidebar.allUnread"), unreadCount],
    ["saved", "bi-star-fill", t("sidebar.saved"), savedCount],
  ] as const;

  return (
    <main className="shell" data-theme={settings.theme}>
      <div className={`workspace mobile-${mobileView}`} style={{ "--sidebar-width": `${sidebarWidth}px`, "--list-width": `${listWidth}px` } as CSSProperties}>
        <aside className="sidebar" aria-label={t("sidebar.feeds")}>
          <header className="sidebarHeader">
            <div className="sidebarBrand">
              <strong>ReadFlux</strong>
            </div>
            <div className="sidebarHeaderActions">
              <button className={`toolbarButton ${refreshBusy ? "spinning" : ""} ${refreshFailed || error ? "failed" : ""}`} aria-disabled={refreshBusy} onClick={() => void refreshFeeds()} aria-label={refreshStatus} title={refreshStatus}><i className={`bi ${refreshFailed || error ? "bi-exclamation-triangle-fill" : "bi-arrow-clockwise"}`} aria-hidden="true" /></button>
              <button className="settingsButton" onClick={() => setSettingsOpen(true)} aria-label={t("settings.title")} title={t("settings.title")}><i className="bi bi-gear" aria-hidden="true" /></button>
            </div>
            {syncProgress && <div className="sidebarProgress" aria-hidden="true"><i style={{ width: `${syncProgress.total ? Math.min(100, syncProgress.loaded / syncProgress.total * 100) : 8}%` }} /></div>}
            <span className="sr-only" role="status">{refreshStatus}</span>
          </header>
          <div className="sidebarScroll" onKeyDown={handleSidebarKey}>
            <nav>{nav.map(([key, icon, label, count]) => <button data-sidebar-row key={key} className={mode === key && !topic ? "active" : ""} onClick={() => { setVisibleIds([]); setListReadSnapshot(new Map(entries.map((entry) => [entry.id, entry.status]))); setMode(key); setTopic(null); setMobileView("list"); }}><i className={`bi ${icon}`} aria-hidden="true" /><span>{label}</span><em>{count}</em></button>)}</nav>
            <div className="sideLabel"><span>{t("sidebar.subscriptions")}</span><button type="button" onClick={() => setSubscriptionsCollapsed((current) => !current)} title={t(subscriptionsCollapsed ? "sidebar.expand" : "sidebar.collapse")} aria-label={t(subscriptionsCollapsed ? "sidebar.expand" : "sidebar.collapse")} aria-expanded={!subscriptionsCollapsed}><i className={`bi ${subscriptionsCollapsed ? "bi-chevron-right" : "bi-chevron-down"}`} aria-hidden="true" /></button></div>
            {!subscriptionsCollapsed && categorySources.map((category) => {
              const collapsed = collapsedCategories.has(category.id);
              const categorySelected = topic?.kind === "category" && topic.id === category.id;
              const categoryUnread = category.feeds.reduce((sum, feed) => sum + (unreadByFeed.get(feed.id) ?? 0), 0);
              return <section className="sourceGroup" key={category.id}>
                <div className={`groupRow ${categorySelected ? "selected" : ""}`}>
                  <button className="disclosure" onClick={() => toggleCategory(category.id)} aria-label={t(collapsed ? "sidebar.expandCategory" : "sidebar.collapseCategory", { title: category.title })} aria-expanded={!collapsed}><i className={`bi ${collapsed ? "bi-folder-fill" : "bi-folder2-open"}`} aria-hidden="true" /></button>
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
          <header className="feedTitle">
            <button className="mobileBack" onClick={() => setMobileView("sources")}>‹ {t("sidebar.feeds")}</button>
            <div className="feedTitleText"><h1>{topicTitle || t(mode === "today" ? "sidebar.today" : mode === "unread" ? "sidebar.allUnread" : "sidebar.saved")}</h1><small>{t("feed.articleCount", { count: visible.length })}{error && entries.length ? ` · ${t("feed.offline")}` : ""}</small></div>
            <div className="feedTitleActions" role="group" aria-label={t("feed.listActions")}>
              <button ref={markAllReadButtonRef} type="button" className={markAllReadOpen ? "markAllReadSpotlight" : ""} onClick={requestMarkVisibleRead} disabled={!visibleUnreadCount} aria-label={t("feed.markAllRead")} title={t("feed.markAllRead")}><i className="bi bi-check2-all" aria-hidden="true" /></button>
              <button type="button" className={hideRead ? "active" : ""} onClick={() => { setVisibleIds([]); setListReadSnapshot(new Map(entries.map((entry) => [entry.id, entry.status]))); setHideRead((current) => !current); }} aria-label={t("feed.hideRead")} title={t(hideRead ? "feed.showRead" : "feed.hideRead")} aria-pressed={hideRead}><i className="bi bi-filter-circle" aria-hidden="true" /></button>
            </div>
          </header>
          {markAllReadOpen && <>
            <div className="markAllReadBackdrop" role="presentation" onMouseDown={dismissMarkAllRead} />
            <section
              className="markAllReadConfirm"
              role="dialog"
              aria-modal="true"
              aria-labelledby="mark-all-read-title"
              style={{
                top: markAllReadPosition.top,
                left: markAllReadPosition.left,
                "--mark-all-arrow-left": `${markAllReadPosition.arrowLeft}px`,
              } as CSSProperties}
            >
              <h2 id="mark-all-read-title">{t("feed.markAllReadConfirm", { count: visibleUnreadCount })}</h2>
              <button ref={markAllReadConfirmRef} type="button" onClick={() => { setMarkAllReadOpen(false); void markVisibleRead(); }}>{t("common.confirm")}</button>
            </section>
          </>}
          <div className="storyList">
            {pendingNew > 0 && <button className="newArticlesPill" onClick={refreshList}>{t("feed.newArticles", { count: pendingNew })}</button>}
            {loading && !entries.length ? <div className="empty"><b className="loadingMark">↻</b><h2>{t("feed.syncing")}</h2><p>{t("feed.syncingHint")}</p></div>
              : error && !entries.length ? <div className="empty errorState"><b>!</b><h2>{t("feed.connectionFailed")}</h2><p>{t(error.key, { status: error.status })}</p><button onClick={() => void load()}>{t("feed.reconnect")}</button></div>
              : visible.length ? visible.map((story) => <article key={story.id} tabIndex={0} className={`story ${selected?.id === story.id ? "selected" : ""} ${story.status === "read" ? "read" : ""} ${entryLabels.has(story.id) && entryLabels.get(story.id)!.includes("updated") ? "updated" : ""}`} onClick={() => { choose(story); setMobileView("reader"); }} onKeyDown={(event) => { if (event.key === "Enter") { choose(story); setMobileView("reader"); } }}>
                <div className="storySource"><SourceIcon src={feedIcons.get(story.feed_id)}>{story.mark}</SourceIcon><span>{story.source}</span><time>{formatZonedTime(story.published_at, activeTimeZone)}</time>{story.starred && <b>★</b>}</div>
                <h2>{story.title}</h2><p>{story.summary}</p>
                <footer><i /><span>{t(story.status === "unread" ? "feed.unread" : entryLabels.get(story.id)?.includes("updated") ? "feed.updated" : story.starred ? "feed.saved" : "feed.read")}</span><span>·</span><span>{t("feed.minutes", { count: story.reading_time || 1 })}</span></footer>
              </article>) : <div className="empty"><b>✓</b><h2>{t("feed.empty")}</h2><p>{t("feed.emptyHint")}</p><button onClick={() => { setVisibleIds([]); setListReadSnapshot(new Map(entries.map((entry) => [entry.id, entry.status]))); setQuery(""); setTopic(null); setMode("today"); setHideRead(false); }}>{t("common.reset")}</button></div>}
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
              <div className="readerToolbar"><button className="mobileBack" onClick={() => setMobileView("list")}>‹ {t("reader.backToArticles")}</button><div><button onClick={() => toggleRead(selected)} title={t(selected.status === "read" ? "reader.markUnread" : "reader.markRead")}>{selected.status === "read" ? "○" : "●"}</button><button className={selected.starred ? "pressed" : ""} title={t(selected.starred ? "reader.unsave" : "reader.save")} onClick={() => void updateEntry(selected.id, { starred: !selected.starred }, () => minifluxFetch(config, `/v1/entries/${selected.id}/bookmark`, { method: "PUT" }), selected.starred ? t("reader.unsaved") : t("reader.saved"))}>{selected.starred ? "★" : "☆"}</button><a href={selected.url} target="_blank" rel="noreferrer" title={t("reader.openOriginal")}>↗</a><button title={t("reader.copyLink")} onClick={async () => { await navigator.clipboard.writeText(selected.url); notify(t("reader.linkCopied")); }}>⧉</button><button title={t("reader.notInterested")} onClick={() => void setFeedback("not_interested")}>−</button></div></div>
              <p className="crumb">{selected.category} · {selected.source}</p>
              <ArticleMetadata
                key={`${selected.id}:${selectedReadingSeconds}`}
                story={selected}
                feedIcon={feedIcons.get(selected.feed_id)}
                timeZone={activeTimeZone}
                initialReadingSeconds={selectedReadingSeconds}
                onReadingTick={recordReadingTick}
                t={t}
              />
              <section className="reason">
                <button className="reasonHead" onClick={() => setReasonOpen(!reasonOpen)}><span>{t("recommendation.reason")}</span><small>{reasonOpen ? t("recommendation.collapse") : t("recommendation.view")}</small></button>
                {reasonOpen && <><p>{selected.reason}</p><div className="tags">{[selected.category, selected.source, ...(selected.tags ?? [])].slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}</div></>}
              </section>
              {contentLoadingId === selected.id
                ? <div className="articleLoading" role="status"><b className="loadingMark">↻</b><p>{t("reader.loadingContent")}</p></div>
                : contentError?.id === selected.id
                  ? <div className="articleLoading errorState"><b>!</b><p>{t(contentError.error.key, { status: contentError.error.status })}</p><button onClick={() => void loadEntryContent(selected.id)}>{t("common.retry")}</button></div>
                  : <ArticleBody content={selected.content} minifluxURL={config.url} imageMode={selectedImageMode} />}
              <div className="feedback"><span>{t("recommendation.feedbackQuestion")}</span><button onClick={() => void setFeedback("helpful")}>{t("recommendation.helpful")}</button><button onClick={() => void setFeedback("not_interested")}>{t("recommendation.notInterested")}</button></div>
            </div>
            <footer className="readerFoot"><span><kbd>J</kbd><kbd>K</kbd> {t("reader.shortcuts")}　<kbd>S</kbd> {t("reader.save")}　<kbd>U</kbd> {t("feed.read")}</span><div><button onClick={() => move(-1)}>{t("reader.previous")}</button><button onClick={() => move(1)}>{t("reader.next")}</button></div></footer>
          </> : <div className="empty readerEmpty"><b>☷</b><h2>{t("reader.select")}</h2><p>{t("reader.selectHint")}</p></div>}
        </article>
      </div>

      {settingsOpen && <SettingsDialog
        config={config}
        feeds={feeds}
        referrerScope={referrerScope}
        imageProxyAvailable={imageProxyAvailable}
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
        onImageModeChange={(feedId) => {
          if (selected && (feedId === undefined || feedId === selected.feed_id)) {
            void loadEntryContent(selected.id);
          }
        }}
        onEventsChange={(next) => {
          if (activeEvent.current) {
            const updatedActiveEvent = next.find((event) => event.id === activeEvent.current?.id);
            activeEvent.current = updatedActiveEvent ? { ...updatedActiveEvent } : null;
          }
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
            notify(t("sync.resetDone"));
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
