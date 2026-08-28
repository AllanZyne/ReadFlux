import { CSSProperties, FormEvent, memo, startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  imageReferrerPolicy,
  imageURLForMode,
  minifluxReferrerScope,
  originalImageURL,
  resolveImageLoadingMode,
  shouldRefreshProxyContent,
  updateDefaultImageLoadingMode,
  updateFeedImageLoadingMode,
  type ImageLoadingMode,
} from "./article-images";
import { articleMediaURL, isWeiboLivePhotoURL, youtubeEmbedURL } from "./article-content";
import { runExclusive } from "./async-lock";
import { incrementalChangedAfter, mergeSyncedEntries, newestChangedAt, sameJsonValue, syncIntervalElapsed } from "./entry-sync";
import {
  entryMutationPatches,
  flushEntryMutationOutbox,
  loadEntryMutationPatches,
  protectPendingEntryMutations,
  type EntryMutationPatch,
} from "./entry-mutation-sync";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "./i18n";
import { loadOptionalMinifluxTimeZone } from "./miniflux-timezone.mjs";
import { articleHash, parseAppRoute, type AppRoute } from "./routes";
import { compareSmartFeedEntries, countSmartFeedEntries, formatStoryListDate, formatZonedDateTime, formatZonedTime, isEntryInSmartFeed, nextDayBoundary, selectTimeZone, smartFeedStatusPriority, smartFeedTimeBucket, toZonedDateTimeInput, zonedDateTimeInputToIso } from "./smart-feeds.mjs";
import { nextStoryRenderCount, STORY_RENDER_BATCH_SIZE, storyIdsPassedByScroll } from "./story-list";
import { storyTextForEntry } from "./story-text";
import {
  addEntryLabel,
  CachedFeedIcon,
  clearConnection,
  clearRemoteRankingExposures,
  clearRemoteReadingEvents,
  clearWebDavConfig,
  ConnectionConfig,
  DEFAULT_FULL_SYNC_INTERVAL,
  DEFAULT_INCREMENTAL_SYNC_INTERVAL,
  deleteReadingEvent,
  EntrySyncPhase,
  EntrySyncState,
  type EntryMutation,
  type StoredEntryMutation,
  getCachedEntries,
  getCachedFeedCatalog,
  getCachedFeedIcons,
  getConnection,
  getEntryLabels,
  getEntrySyncState,
  getProfileSettings,
  getRankingExposures,
  getReadingEvents,
  getRemoteRankingExposures,
  getRemoteReadingEvents,
  getWebDavConfig,
  MinifluxRequestError,
  MinifluxSyncInterval,
  minifluxFetch,
  newReadingEvent,
  markAllRankingExposureMonthsDirty,
  markAllReadingEventMonthsDirty,
  normalizeReadingEventOpenedAt,
  patchReadingEvent,
  putCachedEntries,
  putCachedFeedIcons,
  queueEntryMutations,
  ProfileSettings,
  putRankingExposure,
  putReadingEvent,
  RankingExposure,
  ReadingEvent,
  removeEntryLabel,
  resetEntrySync,
  saveCachedFeedCatalog,
  saveCachedFeedCatalogTimeZone,
  saveConnection,
  saveEntrySyncState,
  saveProfileSettings,
  saveWebDavConfig,
  ThemeName,
  WebDavConfig,
  WebDavSyncInterval,
} from "./readflux-client";
import { createRankingExposure, deriveInterestProfile, rankingAttribution, recommendationDiagnostics, recordBulkDismissal, scoreRecommendation, selectedTopicTermsByEntry, selectedTopicTermsForEntry, type RecommendationScoreBreakdown } from "./recommendation";
import { extractRecommendationCandidateTermsAsync, initializeChineseRecommendationTerms, normalizeRecommendationTerm, normalizeSelectedTopic, prioritizeFollowedTopicTerms } from "./recommendation-terms";
import {
  clearWebDavEtagCache,
  synchronizeWebDav,
  testWebDavConnection,
  webDavConnectionIdentity,
  type WebDavSyncResult,
} from "./webdav-sync";

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
  scoreBreakdown: RecommendationScoreBreakdown;
};
type BaseStory = Entry & Omit<Story, keyof Entry | "score" | "reason" | "scoreBreakdown"> & {
  recommendationText: string;
};
type EntryPage = { total: number; entries: Entry[] };
type ListMode = "today" | "all" | "updated" | "saved";
type Topic = { kind: "category" | "feed"; id: number } | null;
type TopicSelection = {
  term: string;
  top: number;
  left: number;
  arrowLeft: number;
};
type SyncProgress = {
  kind: "full" | "incremental" | "search";
  phase?: EntrySyncPhase;
  loaded: number;
  total: number;
};

type EntrySyncMode = "auto" | "full" | "incremental";
type EntrySyncOptions = { background?: boolean; mode?: EntrySyncMode };

const ENTRY_PAGE_SIZE = 100;

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
    const originalSrc = imageMode === "proxy"
      ? originalImageURL(currentSrc, minifluxURL)
      : null;
    const src = imageURLForMode(currentSrc, minifluxURL, imageMode);
    if (!/^https?:\/\//i.test(src)) image.remove();
    else {
      image.setAttribute("src", src);
      if (originalSrc) {
        image.setAttribute("data-readflux-original-src", originalSrc);
      }
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

function handleArticleImageError(event: React.SyntheticEvent<HTMLDivElement>) {
  const image = event.target;
  if (!(image instanceof HTMLImageElement)) return;
  const originalSrc = image.dataset.readfluxOriginalSrc;
  if (!originalSrc || image.dataset.readfluxFallback === "true") return;
  image.dataset.readfluxFallback = "true";
  image.removeAttribute("srcset");
  image.src = originalSrc;
  image.referrerPolicy = "no-referrer";
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

const StoryRow = memo(function StoryRow({
  story,
  selected,
  updated,
  feedIcon,
  todayClock,
  timeZone,
  locale,
  onChoose,
  t,
}: {
  story: Story;
  selected: boolean;
  updated: boolean;
  feedIcon?: string;
  todayClock: number;
  timeZone: string;
  locale: string;
  onChoose: (story: Story) => void;
  t: TFunction;
}) {
  const statusKey = story.starred
    ? "feed.saved"
    : story.status === "unread"
      ? "feed.unread"
      : updated
        ? "feed.updated"
        : "feed.read";
  return <article
    data-entry-id={story.id}
    role="button"
    tabIndex={0}
    className={`story ${selected ? "selected" : ""} ${story.status === "read" ? "read" : ""} ${updated ? "updated" : ""} ${story.starred ? "starred" : ""}`}
    onClick={() => onChoose(story)}
    onKeyDown={(event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onChoose(story);
    }}
  >
    <div className="storyMain">
      <div className="storySource"><SourceIcon src={feedIcon}>{story.mark}</SourceIcon><span>{story.source}</span></div>
      <h2>{story.title}</h2>
      <footer>{t("feed.minutes", { count: story.reading_time || 1 })}</footer>
    </div>
    <div className="storyStatus">
      <time
        dateTime={story.published_at}
        title={formatZonedDateTime(story.published_at, timeZone)}
      >{formatStoryListDate(story.published_at, todayClock, timeZone, locale)}</time>
      <i aria-hidden="true" />
      <span className="sr-only">{t(statusKey)}</span>
    </div>
  </article>;
});

function captureTextSelection(root: HTMLElement, onTextSelection: (text: string, rect: DOMRect) => void) {
  window.setTimeout(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    if (!selection.anchorNode || !selection.focusNode
      || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    onTextSelection(selection.toString(), rect);
  });
}

function ArticleMetadata({
  story,
  feedIcon,
  timeZone,
  initialReadingSeconds,
  onReadingTick,
  onTextSelection,
  t,
}: {
  story: Story;
  feedIcon?: string;
  timeZone: string;
  initialReadingSeconds: number;
  onReadingTick: () => boolean;
  onTextSelection: (text: string, rect: DOMRect) => void;
  t: TFunction;
}) {
  const [readingSeconds, setReadingSeconds] = useState(initialReadingSeconds);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (onReadingTick()) setReadingSeconds((seconds) => seconds + 5);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [onReadingTick]);

  return <header className="articleHead"><div><h2
    onMouseUp={(event) => captureTextSelection(event.currentTarget, onTextSelection)}
    onTouchEnd={(event) => captureTextSelection(event.currentTarget, onTextSelection)}
  >{story.title}</h2><p><SourceIcon src={feedIcon}>{story.mark}</SourceIcon>{story.author || story.source} · {formatZonedDateTime(story.published_at, timeZone)} · {t("feed.minutes", { count: story.reading_time || 1 })}{readingSeconds > 0 && <span className="articleReadingTime">· {Math.floor(readingSeconds / 60)}:{String(readingSeconds % 60).padStart(2, "0")}</span>}</p></div></header>;
}

const ArticleBody = memo(function ArticleBody({
  content,
  minifluxURL,
  imageMode,
  onTextSelection,
}: {
  content: string;
  minifluxURL: string;
  imageMode: ImageLoadingMode;
  onTextSelection: (text: string, rect: DOMRect) => void;
}) {
  const markup = useMemo(() => ({
    __html: safeHtml(content, minifluxURL, imageMode),
  }), [content, minifluxURL, imageMode]);

  return <div
    className="body articleContent"
    onError={handleArticleImageError}
    onClick={(event) => toggleLivePhoto(event.target)}
    onMouseUp={(event) => captureTextSelection(event.currentTarget, onTextSelection)}
    onTouchEnd={(event) => captureTextSelection(event.currentTarget, onTextSelection)}
    onKeyUp={(event) => {
      if (event.shiftKey || event.key.startsWith("Arrow")) captureTextSelection(event.currentTarget, onTextSelection);
    }}
    onKeyDown={(event) => {
      if ((event.key === "Enter" || event.key === " ") && toggleLivePhoto(event.target)) event.preventDefault();
    }}
    dangerouslySetInnerHTML={markup}
  />;
});

function sameEntryLabels(current: Map<number, string[]>, next: Map<number, string[]>) {
  if (current === next) return true;
  if (current.size !== next.size) return false;
  for (const [entryId, labels] of current) {
    const other = next.get(entryId);
    if (!other || other.length !== labels.length) return false;
    if (!labels.every((label) => other.includes(label))) return false;
  }
  return true;
}

/**
 * Sidebar metadata is re-read on every load. Keeping the previous array when it
 * is unchanged stops dependent effects and memos from recomputing for nothing.
 */
function sameCatalogList<T>(current: T[], next: T[]) {
  return current === next || sameJsonValue(current, next);
}

type EventDraft = Omit<ReadingEvent, "id" | "updatedAt"> & { id?: string };
type WebDavSyncStatus = {
  state: "idle" | "syncing" | "success" | "error";
  syncedAt?: string;
  message?: string;
};

function defaultWebDavClientName() {
  const browser = navigator.userAgent.includes("Safari") && !navigator.userAgent.includes("Chrome") ? "Safari" : "Browser";
  const platform = navigator.userAgent.includes("Mac") ? "macOS" : navigator.platform || "Device";
  return `${browser} · ${platform}`;
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
  exposures,
  starredCount,
  onClose,
  onSettingsChange,
  onImageModeChange,
  onEventsChange,
  webDavConfig,
  webDavStatus,
  onSaveWebDav,
  onSyncWebDav,
  onDisconnectWebDav,
  onDisconnect,
  onSyncEntries,
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
  exposures: RankingExposure[];
  starredCount: number;
  onClose: () => void;
  onSettingsChange: (settings: ProfileSettings) => void;
  onImageModeChange: (feedId?: number) => void;
  onEventsChange: (events: ReadingEvent[]) => void;
  webDavConfig: WebDavConfig | null;
  webDavStatus: WebDavSyncStatus;
  onSaveWebDav: (config: WebDavConfig) => Promise<boolean>;
  onSyncWebDav: () => Promise<boolean>;
  onDisconnectWebDav: () => Promise<void>;
  onDisconnect: () => void;
  onSyncEntries: () => Promise<void>;
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
  const [webDavDraft, setWebDavDraft] = useState<WebDavConfig>(() => webDavConfig ?? {
    url: "",
    username: "",
    password: "",
    clientName: defaultWebDavClientName(),
    intervalMinutes: 15,
  });
  const [webDavSaving, setWebDavSaving] = useState(false);
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

  const setShowFeedArticleCount = async (showFeedArticleCount: boolean) => {
    await saveProfileChange(
      (current) => ({ ...current, showFeedArticleCount, updatedAt: new Date().toISOString() }),
      t("settings.feedArticleCountSaveFailed"),
    );
  };

  const setMarkReadOnScroll = async (markReadOnScroll: boolean) => {
    await saveProfileChange(
      (current) => ({ ...current, markReadOnScroll, updatedAt: new Date().toISOString() }),
      t("settings.markReadOnScrollSaveFailed"),
    );
  };

  const setMinifluxSyncInterval = async (
    field: "incrementalSyncIntervalMinutes" | "fullSyncIntervalMinutes",
    interval: MinifluxSyncInterval,
  ) => {
    await saveProfileChange(
      (current) => ({ ...current, [field]: interval, updatedAt: new Date().toISOString() }),
      t("sync.intervalSaveFailed"),
    );
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

  const resetSync = async () => {
    if (!window.confirm(t("sync.resetConfirm"))) return;
    setResetting(true);
    try {
      await onResetSync();
    } finally {
      setResetting(false);
    }
  };

  const saveWebDav = async () => {
    if (!webDavDraft.url.trim() || !webDavDraft.clientName.trim()) {
      notify(t("webdav.missingFields"));
      return;
    }
    setWebDavSaving(true);
    try {
      await onSaveWebDav({
        ...webDavDraft,
        url: webDavDraft.url.trim(),
        clientName: webDavDraft.clientName.trim(),
      });
    } finally {
      setWebDavSaving(false);
    }
  };

  const disconnectWebDav = async () => {
    await onDisconnectWebDav();
    setWebDavDraft({
      url: "",
      username: "",
      password: "",
      clientName: defaultWebDavClientName(),
      intervalMinutes: 15,
    });
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
  const diagnostics = recommendationDiagnostics(exposures, events);
  const selectedTermsByEntry = useMemo(() => selectedTopicTermsByEntry(events), [events]);
  const normalizedEventQuery = eventQuery.trim().toLowerCase();
  const matchingEvents = [...events]
    .filter((event) => !normalizedEventQuery || `${event.title} ${event.source} ${event.terms.join(" ")}`.toLowerCase().includes(normalizedEventQuery))
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  const shownEvents = normalizedEventQuery ? matchingEvents : matchingEvents.slice(0, 30);
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
            <section>
              <label className="settingToggle">
                <span><strong>{t("settings.feedArticleCount")}</strong><small>{t("settings.feedArticleCountHint")}</small></span>
                <input
                  type="checkbox"
                  checked={settings.showFeedArticleCount}
                  disabled={profileSaving}
                  onChange={(event) => void setShowFeedArticleCount(event.target.checked)}
                />
                <i aria-hidden="true" />
              </label>
            </section>
            <section>
              <label className="settingToggle">
                <span><strong>{t("settings.markReadOnScroll")}</strong><small>{t("settings.markReadOnScrollHint")}</small></span>
                <input
                  type="checkbox"
                  checked={settings.markReadOnScroll}
                  disabled={profileSaving}
                  onChange={(event) => void setMarkReadOnScroll(event.target.checked)}
                />
                <i aria-hidden="true" />
              </label>
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
                <div>
                  {(["incrementalSyncIntervalMinutes", "fullSyncIntervalMinutes"] as const).map((field) => (
                    <label key={field}>
                      <span>{t(field === "incrementalSyncIntervalMinutes" ? "sync.incrementalInterval" : "sync.fullInterval")}</span>
                      <select
                        disabled={profileSaving}
                        value={settings[field]}
                        onChange={(event) => void setMinifluxSyncInterval(field, Number(event.target.value) as MinifluxSyncInterval)}
                      >
                        <option value={0}>{t("sync.intervalManual")}</option>
                        <option value={30}>{t("sync.intervalMinutes", { count: 30 })}</option>
                        <option value={60}>{t("sync.intervalOneHour")}</option>
                        <option value={120}>{t("sync.intervalHours", { count: 2 })}</option>
                        <option value={240}>{t("sync.intervalHours", { count: 4 })}</option>
                        <option value={480}>{t("sync.intervalHours", { count: 8 })}</option>
                      </select>
                    </label>
                  ))}
                </div>
                <div className="settingsActions">
                  <button className="primary" disabled={syncBusy} onClick={() => void onSyncEntries()}>{t("sync.fullNow")}</button>
                </div>
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
            <section className="webDavSettings">
              <div className="settingTitle">
                <div><h3>{t("webdav.title")}</h3><p>{t("webdav.description")}</p></div>
                <span>{webDavConfig ? t("webdav.connected") : t("webdav.notConfigured")}</span>
              </div>
              <div className="settingsForm">
                <label><span>{t("webdav.url")}</span><input type="url" value={webDavDraft.url} placeholder="https://dav.example.com/readflux/" onChange={(event) => setWebDavDraft({ ...webDavDraft, url: event.target.value })} /></label>
                <div>
                  <label><span>{t("webdav.username")}</span><input autoComplete="username" value={webDavDraft.username} onChange={(event) => setWebDavDraft({ ...webDavDraft, username: event.target.value })} /></label>
                  <label><span>{t("webdav.password")}</span><input type="password" autoComplete="current-password" value={webDavDraft.password} onChange={(event) => setWebDavDraft({ ...webDavDraft, password: event.target.value })} /></label>
                </div>
                <div>
                  <label><span>{t("webdav.clientName")}</span><input value={webDavDraft.clientName} onChange={(event) => setWebDavDraft({ ...webDavDraft, clientName: event.target.value })} /></label>
                  <label><span>{t("webdav.interval")}</span><select value={webDavDraft.intervalMinutes} onChange={(event) => setWebDavDraft({ ...webDavDraft, intervalMinutes: Number(event.target.value) as WebDavSyncInterval })}>
                    <option value={0}>{t("webdav.intervalOff")}</option>
                    <option value={5}>{t("webdav.intervalMinutes", { count: 5 })}</option>
                    <option value={15}>{t("webdav.intervalMinutes", { count: 15 })}</option>
                    <option value={30}>{t("webdav.intervalMinutes", { count: 30 })}</option>
                    <option value={60}>{t("webdav.intervalHour")}</option>
                  </select></label>
                </div>
                <p className={`webDavStatus ${webDavStatus.state}`}>
                  {webDavStatus.state === "syncing" ? t("webdav.syncing")
                    : webDavStatus.state === "error" ? webDavStatus.message ?? t("webdav.failed")
                      : webDavStatus.syncedAt ? t("webdav.lastSynced", { time: formatZonedDateTime(webDavStatus.syncedAt, timeZone) })
                        : t("webdav.neverSynced")}
                </p>
                <div className="settingsActions webDavActions">
                  {webDavConfig && <button disabled={webDavStatus.state === "syncing" || webDavSaving} onClick={() => void onSyncWebDav()}>{t("webdav.syncNow")}</button>}
                  <button className="primary" disabled={webDavStatus.state === "syncing" || webDavSaving} onClick={() => void saveWebDav()}>{webDavSaving ? t("webdav.testing") : t("webdav.save")}</button>
                </div>
                {webDavConfig && <button className="disconnect" disabled={webDavStatus.state === "syncing" || webDavSaving} onClick={() => void disconnectWebDav()}>{t("webdav.disconnect")}</button>}
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
            </section>
            <section className="metricGrid">
              <div><strong>{events.length}</strong><span>{t("recommendation.readingEvents")}</span></div>
              <div><strong>{validEvents.length}</strong><span>{t("recommendation.validEvents")}</span></div>
              <div><strong>{t("common.secondsShort", { count: averageSeconds })}</strong><span>{t("recommendation.averageForeground")}</span></div>
              <div><strong>{t("common.percent", { count: averageDepth })}</strong><span>{t("recommendation.averageDepth")}</span></div>
              <div><strong>{helpfulCount}</strong><span>{t("recommendation.helpfulQuoted")}</span></div>
              <div><strong>{negativeCount}</strong><span>{t("recommendation.notInterestedQuoted")}</span></div>
              <div><strong>{starredCount}</strong><span>{t("recommendation.saved")}</span></div>
              <div><strong>{diagnostics.exposureCount}</strong><span>{t("recommendation.exposures")}</span></div>
              <div><strong>{diagnostics.displayedCount}</strong><span>{t("recommendation.impressions")}</span></div>
              <div><strong>{diagnostics.attributedOpenCount}</strong><span>{t("recommendation.attributedOpens")}</span></div>
              <div><strong>{diagnostics.engagedOpenCount}</strong><span>{t("recommendation.engagedOpens")}</span></div>
              <div><strong>{diagnostics.clampedPercent.toFixed(1)}%</strong><span>{t("recommendation.saturation")}</span></div>
              <div><strong>{diagnostics.tiePercent.toFixed(1)}%</strong><span>{t("recommendation.tieRate")}</span></div>
            </section>
            <section className="derivedData twoColumns">
              <div>
                <header><h3>{t("recommendation.sourceWeights")}</h3><small>{t("recommendation.sourceWeightsHint")}</small></header>
                <div className="weightList">{topSources.length ? topSources.map(([feedId, weight]) => <span key={feedId}><b>{sourceName.get(feedId) ?? `${t("common.feed")} ${feedId}`}</b><em>{weight.toFixed(2)}</em></span>) : <p>{t("recommendation.noWeights")}</p>}</div>
              </div>
              <div>
                <header><h3>{t("recommendation.positiveTerms")}</h3><small>{t("recommendation.positiveTermsHint")}</small></header>
                <div className="weightTags">{topWords.length ? topWords.map(([word, weight]) => <span key={word}>{word}<em>{weight.toFixed(1)}</em></span>) : <p>{t("recommendation.noKeywords")}</p>}</div>
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
                {shownEvents.length ? shownEvents.map((event) => <div className="eventRow" key={`${event.remoteClientId ?? "local"}:${event.id}`}>
                  <span><strong>{event.title}</strong><small>{event.source} · {formatZonedDateTime(event.openedAt, timeZone)}{event.remoteClientName ? ` · ${event.remoteClientName}` : ""}</small></span>
                  <span><b>{t("common.secondsShort", { count: Math.round(event.activeSeconds) })}</b><small>{t("recommendation.scrollSummary", { depth: Math.round(event.scrollDepth * 100), origin: t(`recommendation.origin${event.origin[0].toUpperCase()}${event.origin.slice(1)}`) })}</small></span>
                  <span><b>{event.feedback === "helpful" ? t("recommendation.helpful") : event.feedback === "not_interested" ? t("recommendation.notInterested") : t("recommendation.implicit")}</b><small>{[...(selectedTermsByEntry.get(event.entryId) ?? [])].join(" · ") || t("recommendation.noSelectedTopics")}</small><small>{t("recommendation.candidateSummary", { terms: event.terms.slice(0, 5).join(" · ") || t("recommendation.noTerms") })}</small></span>
                  <span>{event.remoteClientId
                    ? <small>{t("webdav.remoteReadOnly")}</small>
                    : <><button onClick={() => setDraft({ ...event })}>{t("common.edit")}</button><button className="danger" onClick={() => void removeEvent(event)}>{t("common.delete")}</button></>}</span>
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
      const settings = await getProfileSettings();
      onConnected(config, settings);
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
  const [remoteEvents, setRemoteEvents] = useState<ReadingEvent[]>([]);
  const [exposures, setExposures] = useState<RankingExposure[]>([]);
  const [remoteExposures, setRemoteExposures] = useState<RankingExposure[]>([]);
  const [webDavConfig, setWebDavConfig] = useState<WebDavConfig | null>(null);
  const [webDavStatus, setWebDavStatus] = useState<WebDavSyncStatus>({ state: "idle" });
  const [settings, setSettings] = useState<ProfileSettings>({
    theme: "day",
    showFeedArticleCount: false,
    markReadOnScroll: true,
    imageLoadingPreferences: {},
    incrementalSyncIntervalMinutes: DEFAULT_INCREMENTAL_SYNC_INTERVAL,
    fullSyncIntervalMinutes: DEFAULT_FULL_SYNC_INTERVAL,
    updatedAt: new Date(0).toISOString(),
  });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [route, setRoute] = useState<AppRoute>(() => parseAppRoute(window.location.hash));
  const [mode, setMode] = useState<ListMode>("today");
  const [minifluxTimeZone, setMinifluxTimeZone] = useState<string>();
  const [todayClock, setTodayClock] = useState(() => Date.now());
  const timeZoneSelection = useMemo(
    () => selectTimeZone(minifluxTimeZone),
    [minifluxTimeZone],
  );
  const activeTimeZone = timeZoneSelection.timeZone;
  const [topic, setTopic] = useState<Topic>(null);
  const [query] = useState("");
  const [hideReadByMode, setHideReadByMode] = useState<Record<ListMode, boolean>>({
    today: false,
    all: false,
    updated: false,
    saved: false,
  });
  const hideRead = mode !== "updated" && hideReadByMode[mode];
  const [listReadSnapshot, setListReadSnapshot] = useState<Map<number, Entry["status"]>>(() => {
    try {
      const stored = localStorage.getItem("readflux.listSnapshot");
      if (stored) return new Map(JSON.parse(stored) as [number, Entry["status"]][]);
    } catch { /* ignore */ }
    return new Map();
  });
  const [sourceSnapshot, setSourceSnapshot] = useState<{
    statuses: Map<number, Entry["status"]>;
    labels: Map<number, string[]>;
  }>(() => ({ statuses: new Map(), labels: new Map() }));
  const [reasonOpen, setReasonOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [markAllReadOpen, setMarkAllReadOpen] = useState(false);
  const [markAllReadPosition, setMarkAllReadPosition] = useState({ top: 0, left: 0, arrowLeft: 0 });
  const [topicSelection, setTopicSelection] = useState<TopicSelection | null>(null);
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
  const [activeCandidates, setActiveCandidates] = useState<{ entryId: number; terms: string[]; loading: boolean } | null>(null);
  const [entryLabels, setEntryLabels] = useState<Map<number, string[]>>(new Map());
  const [listOrderVersion, setListOrderVersion] = useState(0);
  const [renderedStoryCount, setRenderedStoryCount] = useState(STORY_RENDER_BATCH_SIZE);
  const [referrerScopeState, setReferrerScopeState] = useState({ url: "", scope: "" });
  // Bumped whenever a catalog refresh starts or the connection changes, so a
  // late-resolving timezone request from a superseded load is discarded.
  const catalogRevision = useRef(0);
  const entriesRef = useRef<Entry[]>([]);
  const activeEvent = useRef<ReadingEvent | null>(null);
  const latestExposure = useRef<RankingExposure | null>(null);
  const storyListRef = useRef<HTMLDivElement | null>(null);
  const readerRef = useRef<HTMLDivElement | null>(null);
  const markAllReadButtonRef = useRef<HTMLButtonElement | null>(null);
  const markAllReadConfirmRef = useRef<HTMLButtonElement | null>(null);
  const topicSelectionConfirmRef = useRef<HTMLButtonElement | null>(null);
  const autoReadFrame = useRef<number | undefined>(undefined);
  const autoReadPendingIds = useRef<Set<number>>(new Set());
  const previousStoryListScrollTop = useRef(0);
  const sourceSnapshotInitialized = useRef(false);
  const refreshInFlight = useRef(false);
  const syncInFlight = useRef(false);
  const syncQueued = useRef<EntrySyncMode | null>(null);
  const syncStateRef = useRef<EntrySyncState | null>(null);
  const hydratedConnectionRef = useRef<ConnectionConfig | null>(null);
  const pendingEntryMutationsRef = useRef<Map<number, EntryMutationPatch>>(new Map());
  const pendingEntryMutationGeneration = useRef(0);
  const syncResetInProgress = useRef(false);
  const listSnapshotIds = useRef<Set<number>>(new Set());
  const visibleEmptyRef = useRef(true);
  const modeRef = useRef(mode);
  const topicRef = useRef(topic);
  const feedsRef = useRef(feeds);
  const hideReadRef = useRef(hideRead);
  const queryRef = useRef(query);
  const loadRef = useRef<(options?: EntrySyncOptions) => Promise<boolean>>(async () => false);
  const proxyRefreshKey = useRef("");
  const routeRef = useRef(route);
  const webDavUploadTimer = useRef<number | undefined>(undefined);
  const termExtractorRequested = useRef(false);
  const capturedVisibleOrder = useRef<number[] | null>(null);
  const recommendationEvents = useMemo(() => [...events, ...remoteEvents], [events, remoteEvents]);
  const recommendationExposures = useMemo(() => [...exposures, ...remoteExposures], [exposures, remoteExposures]);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }, []);

  const rememberQueuedEntryMutations = useCallback((mutations: StoredEntryMutation[]) => {
    const queuedPatches = entryMutationPatches(mutations);
    const next = new Map(pendingEntryMutationsRef.current);
    queuedPatches.forEach((patch, entryId) => {
      next.set(entryId, { ...next.get(entryId), ...patch });
    });
    pendingEntryMutationsRef.current = next;
    pendingEntryMutationGeneration.current += 1;
  }, []);

  const flushPendingEntryMutations = useCallback(async () => {
    if (!config) return 0;
    try {
      return await flushEntryMutationOutbox(config);
    } finally {
      try {
        const generation = pendingEntryMutationGeneration.current;
        const persistedPatches = await loadEntryMutationPatches(config);
        if (syncInFlight.current || pendingEntryMutationGeneration.current !== generation) {
          const protectedPatches = new Map(pendingEntryMutationsRef.current);
          persistedPatches.forEach((patch, entryId) => {
            protectedPatches.set(entryId, { ...protectedPatches.get(entryId), ...patch });
          });
          pendingEntryMutationsRef.current = protectedPatches;
        } else {
          pendingEntryMutationsRef.current = persistedPatches;
        }
      } catch { /* keep the in-memory protection until the outbox can be read again */ }
    }
  }, [config]);

  const runWebDavSync = useCallback(async (override?: WebDavConfig, pull = true) => {
    const activeConfig = override ?? webDavConfig;
    if (!activeConfig) return false;
    setWebDavStatus((current) => ({ ...current, state: "syncing", message: undefined }));
    try {
      const result: WebDavSyncResult = await synchronizeWebDav(activeConfig, { pull });
      setRemoteEvents(result.events);
      setRemoteExposures(result.exposures);
      setWebDavStatus({ state: "success", syncedAt: result.syncedAt });
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t("webdav.failed");
      setWebDavStatus((current) => ({ ...current, state: "error", message }));
      return false;
    }
  }, [t, webDavConfig]);

  const handleSaveWebDav = useCallback(async (next: WebDavConfig) => {
    setWebDavStatus((current) => ({ ...current, state: "syncing", message: undefined }));
    try {
      await testWebDavConnection(next);
      const connectionChanged = webDavConfig !== null
        && webDavConnectionIdentity(webDavConfig) !== webDavConnectionIdentity(next);
      if (webDavConfig && connectionChanged) {
        clearWebDavEtagCache();
        await Promise.all([clearRemoteReadingEvents(), clearRemoteRankingExposures()]);
        setRemoteEvents([]);
        setRemoteExposures([]);
      }
      saveWebDavConfig(next);
      setWebDavConfig(next);
      if (!webDavConfig || connectionChanged || webDavConfig.clientName !== next.clientName) {
        await Promise.all([markAllReadingEventMonthsDirty(), markAllRankingExposureMonthsDirty()]);
      }
      const synced = await runWebDavSync(next);
      if (synced) notify(t("webdav.saved"));
      return synced;
    } catch (cause) {
      setWebDavStatus({ state: "error", message: cause instanceof Error ? cause.message : t("webdav.failed") });
      return false;
    }
  }, [notify, runWebDavSync, t, webDavConfig]);

  const handleDisconnectWebDav = useCallback(async () => {
    clearWebDavConfig();
    clearWebDavEtagCache();
    await Promise.all([clearRemoteReadingEvents(), clearRemoteRankingExposures()]);
    setRemoteEvents([]);
    setRemoteExposures([]);
    setWebDavConfig(null);
    setWebDavStatus({ state: "idle" });
    notify(t("webdav.disconnected"));
  }, [notify, t]);

  const scheduleWebDavUpload = useCallback(() => {
    if (!webDavConfig) return;
    if (webDavUploadTimer.current !== undefined) window.clearTimeout(webDavUploadTimer.current);
    webDavUploadTimer.current = window.setTimeout(() => {
      webDavUploadTimer.current = undefined;
      void runWebDavSync(undefined, false);
    }, 30_000);
  }, [runWebDavSync, webDavConfig]);

  const replaceEntries = useCallback((update: Entry[] | ((current: Entry[]) => Entry[])) => {
    const next = typeof update === "function" ? update(entriesRef.current) : update;
    entriesRef.current = next;
    setEntries(next);
    return next;
  }, []);

  const captureSourceSnapshot = useCallback((snapshotEntries: Entry[], labels: Map<number, string[]>) => {
    sourceSnapshotInitialized.current = true;
    setSourceSnapshot({
      statuses: new Map(snapshotEntries.map((entry) => [entry.id, entry.status])),
      labels: new Map(labels),
    });
  }, []);

  useEffect(() => {
    if (loading || sourceSnapshotInitialized.current || !entries.length) return;
    captureSourceSnapshot(entries, entryLabels);
  }, [captureSourceSnapshot, entries, entryLabels, loading]);

  const navigateToArticle = useCallback((entryId: number) => {
    const hash = articleHash(entryId);
    if (window.location.hash === hash) return;
    window.history.pushState(null, "", hash);
    setRoute({ kind: "article", entryId });
  }, []);

  const navigateToList = useCallback(() => {
    if (window.location.hash === "#/") return;
    window.history.pushState(null, "", "#/");
    setRoute({ kind: "list" });
  }, []);

  useEffect(() => { listSnapshotIds.current = new Set(listReadSnapshot.keys()); }, [listReadSnapshot]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { topicRef.current = topic; }, [topic]);
  useEffect(() => { feedsRef.current = feeds; }, [feeds]);
  useEffect(() => { hideReadRef.current = hideRead; }, [hideRead]);
  useEffect(() => { queryRef.current = query; }, [query]);
  useEffect(() => { routeRef.current = route; }, [route]);

  useEffect(() => {
    const readRoute = () => setRoute(parseAppRoute(window.location.hash));
    window.addEventListener("hashchange", readRoute);
    window.addEventListener("popstate", readRoute);
    return () => {
      window.removeEventListener("hashchange", readRoute);
      window.removeEventListener("popstate", readRoute);
    };
  }, []);

  useEffect(() => {
    const now = new Date();
    const nextMidnight = nextDayBoundary(now, activeTimeZone);
    const timer = window.setTimeout(() => {
      setTodayClock(Date.now());
    }, Math.max(1_000, nextMidnight.getTime() - now.getTime() + 100));
    return () => window.clearTimeout(timer);
  }, [todayClock, activeTimeZone]);

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
  const imageProxyAvailable = true;

  useEffect(() => {
    Promise.all([getReadingEvents(), getRemoteReadingEvents(), getProfileSettings(), getRankingExposures(), getRemoteRankingExposures()]).then(async ([history, remoteHistory, profile, storedExposures, storedRemoteExposures]) => {
      if (profile.language) await i18n.changeLanguage(profile.language);
      setEvents(history);
      setRemoteEvents(remoteHistory);
      setExposures(storedExposures);
      setRemoteExposures(storedRemoteExposures);
      setWebDavConfig(getWebDavConfig());
      setSettings(profile);
      setConfig(getConnection());
      setReady(true);
    });
  }, [i18n]);

  useEffect(() => {
    if (termExtractorRequested.current || !entries.some((entry) => /\p{Script=Han}/u.test(entry.title))) return;
    termExtractorRequested.current = true;
    void initializeChineseRecommendationTerms();
  }, [entries]);

  useEffect(() => {
    if (!ready || !webDavConfig) return;
    queueMicrotask(() => void runWebDavSync());
    if (!webDavConfig.intervalMinutes) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void runWebDavSync();
    }, webDavConfig.intervalMinutes * 60_000);
    return () => window.clearInterval(timer);
  }, [ready, runWebDavSync, webDavConfig]);

  useEffect(() => {
    const syncWhenVisible = () => {
      if (document.visibilityState === "visible" && webDavConfig) void runWebDavSync();
    };
    document.addEventListener("visibilitychange", syncWhenVisible);
    return () => document.removeEventListener("visibilitychange", syncWhenVisible);
  }, [runWebDavSync, webDavConfig]);

  useEffect(() => () => {
    if (webDavUploadTimer.current !== undefined) window.clearTimeout(webDavUploadTimer.current);
  }, []);

  useEffect(() => {
    if (ready && webDavConfig) scheduleWebDavUpload();
  }, [events, ready, scheduleWebDavUpload, webDavConfig]);

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
    const protectedBatch = protectPendingEntryMutations(batch, pendingEntryMutationsRef.current);
    const { entries: mergedEntries, mergedBatch, updatedIds } = mergeSyncedEntries(entriesRef.current, protectedBatch);
    replaceEntries(mergedEntries);
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
      const currentHideRead = hideReadRef.current && currentMode !== "updated";
      const matchesCurrentMode = (entry: Entry) => (
        currentMode === "updated" && entry.status === "read" && updatedIds.has(entry.id)
      ) || isEntryInSmartFeed(entry, currentMode, entryLabels);
      const relevant = protectedBatch.filter((entry) => {
        if (listSnapshotIds.current.has(entry.id)) return false;
        if (!matchesCurrentMode(entry)) return false;
        if (currentHideRead && entry.status === "read") return false;
        if (currentTopic?.kind === "category") {
          const feed = feedsRef.current.find((f) => f.id === entry.feed_id);
          if (feed?.category?.id !== currentTopic.id) return false;
        }
        if (currentTopic?.kind === "feed" && entry.feed_id !== currentTopic.id) return false;
        return true;
      });
      const updatedInList = protectedBatch.filter((entry) => {
        if (!updatedIds.has(entry.id)) return false;
        if (!listSnapshotIds.current.has(entry.id)) return false;
        if (!matchesCurrentMode(entry)) return false;
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
    await putCachedEntries(config, mergedBatch);
  }, [config, entryLabels, replaceEntries]);

  const load = useCallback(async (options?: EntrySyncOptions) => {
    if (!config) return false;
    if (syncResetInProgress.current || syncInFlight.current) {
      const requestedMode = options?.mode ?? "auto";
      if (requestedMode === "full" || !syncQueued.current) syncQueued.current = requestedMode;
      return false;
    }
    const background = options?.background ?? false;
    syncInFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      try {
        await flushPendingEntryMutations();
      } catch { /* pending local state remains protected while article refresh continues */ }
      const [cached, storedState, labels, cachedCatalog] = await Promise.all([
        getCachedEntries<Entry>(config),
        getEntrySyncState(config),
        getEntryLabels(config),
        getCachedFeedCatalog<Feed, Category>(config).catch(() => null),
      ]);
      setEntryLabels((current) => sameEntryLabels(current, labels) ? current : labels);
      replaceEntries(cached);
      syncStateRef.current = storedState;
      const initialCacheHydration = hydratedConnectionRef.current !== config;
      hydratedConnectionRef.current = config;
      const snapshotMissesCache = !listSnapshotIds.current.size
        || !cached.some((entry) => listSnapshotIds.current.has(entry.id));
      if (initialCacheHydration || snapshotMissesCache) {
        setListOrderVersion((version) => version + 1);
      }
      if (initialCacheHydration) {
        sourceSnapshotInitialized.current = false;
        if (cached.length) captureSourceSnapshot(cached, labels);
        else setSourceSnapshot({ statuses: new Map(), labels: new Map() });
      }
      if (snapshotMissesCache) {
        setListReadSnapshot(new Map(cached.map((entry) => [entry.id, entry.status])));
      }
      if (cachedCatalog) {
        setFeeds((current) => sameCatalogList(current, cachedCatalog.feeds) ? current : cachedCatalog.feeds);
        setCategories((current) => (
          sameCatalogList(current, cachedCatalog.categories) ? current : cachedCatalog.categories
        ));
        if (cachedCatalog.timeZone) setMinifluxTimeZone(cachedCatalog.timeZone);
      }
      setSelectedId((current) => current && cached.some((entry) => entry.id === current) ? current : null);

      const requestedMode = options?.mode ?? "auto";
      const initialSyncRequired = storedState?.initialSyncComplete !== true;
      const lastFullSyncAt = storedState?.lastFullSyncAt ?? storedState?.updatedAt;
      const fullSyncDue = syncIntervalElapsed(lastFullSyncAt, settings.fullSyncIntervalMinutes);
      const incrementalSyncDue = syncIntervalElapsed(
        storedState?.lastIncrementalSyncAt ?? lastFullSyncAt,
        settings.incrementalSyncIntervalMinutes,
      );
      const syncMode: Exclude<EntrySyncMode, "auto"> | null = initialSyncRequired || requestedMode === "full"
        ? "full"
        : requestedMode === "incremental"
          ? "incremental"
          : fullSyncDue
            ? "full"
            : incrementalSyncDue
              ? "incremental"
              : null;

      // Account, feed, and category metadata follows the entry sync cadence.
      // Without a local catalog there is nothing to render the sidebar from, so
      // that first fetch still happens regardless of what is due.
      if (syncMode || !cachedCatalog) {
        const [feedData, categoryData] = await Promise.all([
          minifluxFetch<Feed[]>(config, "/v1/feeds"),
          minifluxFetch<Category[]>(config, "/v1/categories"),
        ]);
        const nextFeeds = feedData ?? [];
        const nextCategories = categoryData ?? [];
        setFeeds((current) => sameCatalogList(current, nextFeeds) ? current : nextFeeds);
        setCategories((current) => sameCatalogList(current, nextCategories) ? current : nextCategories);
        // Persist before continuing so a following load reads the catalog
        // instead of racing this write and refetching the same metadata.
        await saveCachedFeedCatalog<Feed, Category>(config, {
          feeds: nextFeeds,
          categories: nextCategories,
          timeZone: cachedCatalog?.timeZone,
        }).catch(() => undefined);
        // The timezone request never blocks the sync; it upgrades the stored
        // catalog once it settles. The revision guard drops the result when a
        // newer load or a connection change has superseded this one, and the
        // write touches only the timezone so it cannot clobber newer feeds.
        const revision = ++catalogRevision.current;
        void loadOptionalMinifluxTimeZone(() => minifluxFetch<MinifluxUser>(config, "/v1/me"))
          .then((timeZone) => {
            if (!timeZone || revision !== catalogRevision.current) return;
            setMinifluxTimeZone(timeZone);
            return saveCachedFeedCatalogTimeZone(config, timeZone);
          })
          .catch(() => undefined);
      }

      if (!syncMode) {
        const lastSyncAt = storedState?.lastIncrementalSyncAt ?? lastFullSyncAt;
        if (lastSyncAt) setSyncedAt(new Date(lastSyncAt));
        return true;
      }

      if (syncMode === "full") {
        const phases: { id: EntrySyncPhase; filters: Record<string, string> }[] = [
          { id: "unread", filters: { status: "unread" } },
          { id: "starred", filters: { status: "read", starred: "true" } },
          { id: "read", filters: { status: "read", starred: "false" } },
        ];
        const canResume = storedState?.initialSyncComplete === false;
        const resumeIndex = canResume && storedState.phase
          ? Math.max(0, phases.findIndex((phase) => phase.id === storedState.phase))
          : 0;
        for (let index = resumeIndex; index < phases.length; index += 1) {
          const phase = phases[index];
          const startOffset = index === resumeIndex
            && canResume
            && storedState?.phase === phase.id
            ? storedState.offset ?? 0
            : 0;
          await loadEntryPages(config, phase.filters, async (batch, loaded, total, nextOffset) => {
            setSyncProgress({ kind: "full", phase: phase.id, loaded, total });
            await mergeEntryBatch(batch);
            const nextState: EntrySyncState = {
              ...storedState,
              initialSyncComplete: false,
              phase: phase.id,
              offset: nextOffset,
            };
            await saveEntrySyncState(config, nextState);
            syncStateRef.current = nextState;
          }, startOffset);
          const nextPhase = phases[index + 1]?.id;
          if (nextPhase) {
            const nextState: EntrySyncState = {
              ...storedState,
              initialSyncComplete: false,
              phase: nextPhase,
              offset: 0,
            };
            await saveEntrySyncState(config, nextState);
            syncStateRef.current = nextState;
          }
        }

        const completedAt = new Date().toISOString();
        const completedState: EntrySyncState = {
          initialSyncComplete: true,
          incrementalCursor: newestChangedAt(entriesRef.current, storedState?.incrementalCursor),
          lastIncrementalSyncAt: completedAt,
          lastFullSyncAt: completedAt,
          updatedAt: completedAt,
        };
        await saveEntrySyncState(config, completedState);
        syncStateRef.current = completedState;
      } else {
        let incrementalCursor = storedState?.incrementalCursor ?? newestChangedAt(cached);
        const changedAfter = incrementalChangedAfter(incrementalCursor);
        await loadEntryPages(config, {
          order: "changed_at",
          direction: "asc",
          ...(changedAfter ? { changed_after: changedAfter } : {}),
        }, async (batch, loaded, total) => {
          setSyncProgress({ kind: "incremental", loaded, total });
          await mergeEntryBatch(batch);
          incrementalCursor = newestChangedAt(batch, incrementalCursor);
        });
        const completedAt = new Date().toISOString();
        const completedState: EntrySyncState = {
          ...storedState,
          initialSyncComplete: true,
          incrementalCursor,
          lastIncrementalSyncAt: completedAt,
          phase: undefined,
          offset: undefined,
        };
        await saveEntrySyncState(config, completedState);
        syncStateRef.current = completedState;
      }
      setSyncedAt(new Date());
      if (!background && !listSnapshotIds.current.size) {
        setListReadSnapshot(new Map(entriesRef.current.map((entry) => [entry.id, entry.status])));
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
      const mutationGeneration = pendingEntryMutationGeneration.current;
      void loadEntryMutationPatches(config).then((patches) => {
        if (pendingEntryMutationGeneration.current === mutationGeneration) {
          pendingEntryMutationsRef.current = patches;
          return;
        }
        const protectedPatches = new Map(pendingEntryMutationsRef.current);
        patches.forEach((patch, entryId) => {
          protectedPatches.set(entryId, { ...protectedPatches.get(entryId), ...patch });
        });
        pendingEntryMutationsRef.current = protectedPatches;
      }).catch(() => undefined);
      if (syncQueued.current) {
        const queuedMode = syncQueued.current;
        syncQueued.current = null;
        queueMicrotask(() => void loadRef.current({ background: true, mode: queuedMode }));
      }
    }
  }, [captureSourceSnapshot, config, flushPendingEntryMutations, mergeEntryBatch, replaceEntries, settings.fullSyncIntervalMinutes, settings.incrementalSyncIntervalMinutes]);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  // Loads when a connection appears. This deliberately does not depend on the
  // `load` identity: legitimate state changes recreate that callback, and
  // depending on it would turn every one of them into another sync.
  useEffect(() => {
    catalogRevision.current += 1;
    if (config) queueMicrotask(() => void loadRef.current());
  }, [config]);

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
    const runScheduledSync = () => {
      if (document.visibilityState !== "visible" || refreshInFlight.current) return;
      const syncState = syncStateRef.current;
      const mode = syncState?.initialSyncComplete !== true
        ? "full"
        : syncIntervalElapsed(syncState.lastFullSyncAt ?? syncState.updatedAt, settings.fullSyncIntervalMinutes)
          ? "full"
          : syncIntervalElapsed(
              syncState.lastIncrementalSyncAt ?? syncState.lastFullSyncAt ?? syncState.updatedAt,
              settings.incrementalSyncIntervalMinutes,
            )
            ? "incremental"
            : null;
      if (mode) void loadRef.current({ background: true, mode });
    };
    const timer = window.setInterval(runScheduledSync, 60_000);
    document.addEventListener("visibilitychange", runScheduledSync);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", runScheduledSync);
    };
  }, [config, settings.fullSyncIntervalMinutes, settings.incrementalSyncIntervalMinutes]);

  useEffect(() => {
    if (!config) return;
    const retryPendingMutations = () => {
      if (document.visibilityState === "visible") void flushPendingEntryMutations().catch(() => undefined);
    };
    const timer = window.setInterval(retryPendingMutations, 2 * 60_000);
    document.addEventListener("visibilitychange", retryPendingMutations);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", retryPendingMutations);
    };
  }, [config, flushPendingEntryMutations]);

  useEffect(() => {
    if (!config || !feeds.length) return;
    let cancelled = false;
    const withIcons = feeds.filter((feed) => feed.icon);
    void (async () => {
      let cachedIcons: CachedFeedIcon[] = [];
      try {
        cachedIcons = await getCachedFeedIcons(config);
      } catch { /* icon cache is best-effort */ }
      if (cancelled) return;

      const currentIconIds = new Map(withIcons.map((feed) => [feed.id, feed.icon!.icon_id]));
      const validCachedIcons = cachedIcons.filter((icon) =>
        currentIconIds.get(icon.feedId) === icon.iconId);
      const cachedSources = new Map(validCachedIcons.map((icon) => [icon.feedId, icon.src]));
      setFeedIcons(cachedSources);

      const cachedFeedIds = new Set(validCachedIcons.map((icon) => icon.feedId));
      const uncachedFeeds = withIcons.filter((feed) => !cachedFeedIds.has(feed.id));
      const loadedIcons = (await Promise.all(uncachedFeeds.map(async (feed) => {
        try {
          const icon = await minifluxFetch<FeedIcon>(config, `/v1/feeds/${feed.id}/icon`);
          const src = icon.data.startsWith("data:") ? icon.data : `data:${icon.data}`;
          return { feedId: feed.id, iconId: feed.icon!.icon_id, src };
        } catch {
          return null;
        }
      }))).filter((icon): icon is CachedFeedIcon => icon !== null);

      try {
        await putCachedFeedIcons(config, loadedIcons);
      } catch { /* icon cache is best-effort */ }
      if (!cancelled && loadedIcons.length) {
        setFeedIcons(new Map([
          ...cachedSources,
          ...loadedIcons.map((icon) => [icon.feedId, icon.src] as const),
        ]));
      }
    })();
    return () => { cancelled = true; };
  }, [config, feeds]);

  const feedMap = useMemo(() => new Map(feeds.map((feed) => [feed.id, feed])), [feeds]);
  const interest = useMemo(() => deriveInterestProfile(
    recommendationEvents,
    entries.filter((entry) => entry.starred).map((entry) => ({ feedId: entry.feed_id })),
    syncedAt?.getTime() ?? todayClock,
  ), [recommendationEvents, entries, syncedAt, todayClock]);

  const baseStories = useMemo<BaseStory[]>(() => {
    return entries.map((entry) => {
      const feed = entry.feed ?? feedMap.get(entry.feed_id);
      const source = feed?.title ?? t("feed.unknownSource");
      const category = feed?.category?.title ?? t("settings.uncategorized");
      const text = storyTextForEntry(entry);
      return {
        ...entry,
        source,
        category,
        categoryId: feed?.category?.id,
        mark: source.trim().slice(0, 1).toUpperCase() || "·",
        summary: text.summary ? `${text.summary}${text.summary.length >= 160 ? "…" : ""}` : t("feed.noSummary"),
        recommendationText: text.recommendationText,
      };
    });
  }, [entries, feedMap, t]);

  const stories = useMemo<Story[]>(() => {
    return baseStories.map((story) => {
      const sourceAffinity = interest.sources.get(story.feed_id) ?? 0;
      const scoreBreakdown = scoreRecommendation({
        feedId: story.feed_id,
        text: story.recommendationText,
        publishedAt: story.published_at,
        starred: story.starred,
        now: syncedAt?.getTime() ?? todayClock,
        profile: interest,
      });
      const terms = scoreBreakdown.matchedTerms.slice(0, 2).join(", ");
      const reason = sourceAffinity >= 2
        ? t("recommendation.reasonSource", { source: story.source, interest: scoreBreakdown.matchedTerms[0] ? t("recommendation.reasonSourceInterest", { terms }) : "" })
        : scoreBreakdown.matchedTerms[0]
          ? t("recommendation.reasonTerms", { terms })
          : story.starred
            ? t("recommendation.reasonSaved")
            : recommendationEvents.length
              ? t("recommendation.reasonCategory", { category: story.category })
              : t("recommendation.reasonNew");
      return {
        ...story,
        score: scoreBreakdown.score,
        scoreBreakdown,
        reason,
      };
    });
  }, [baseStories, recommendationEvents.length, interest, syncedAt, todayClock, t]);

  const persistActive = useCallback(async () => {
    if (!activeEvent.current) return;
    activeEvent.current.updatedAt = new Date().toISOString();
    await putReadingEvent(activeEvent.current);
    scheduleWebDavUpload();
  }, [scheduleWebDavUpload]);

  const commitActiveEvent = useCallback(() => {
    if (!activeEvent.current) return;
    const snapshot = { ...activeEvent.current };
    startTransition(() => {
      setEvents((all) => {
        const index = all.findIndex((event) => event.id === snapshot.id);
        return index < 0 ? [...all, snapshot] : all.map((event, i) => i === index ? snapshot : event);
      });
    });
  }, []);

  const resetRenderedStories = useCallback(() => {
    setRenderedStoryCount(STORY_RENDER_BATCH_SIZE);
    previousStoryListScrollTop.current = 0;
    if (storyListRef.current) storyListRef.current.scrollTop = 0;
  }, []);

  const refreshList = useCallback(() => {
    commitActiveEvent();
    resetRenderedStories();
    setListReadSnapshot(new Map(entriesRef.current.map((entry) => [entry.id, entry.status])));
    captureSourceSnapshot(entriesRef.current, entryLabels);
    setPendingNew(0);
  }, [captureSourceSnapshot, commitActiveEvent, entryLabels, resetRenderedStories]);

  const switchListContext = useCallback((nextMode: ListMode, nextTopic: Topic) => {
    const currentTopic = topicRef.current;
    const changingSmartFeed = modeRef.current !== nextMode;
    const returningToSmartFeed = !changingSmartFeed && currentTopic !== null && nextTopic === null;
    const sameTopic = (
      currentTopic?.kind === nextTopic?.kind && currentTopic?.id === nextTopic?.id
    ) || (currentTopic === null && nextTopic === null);
    if (modeRef.current === nextMode && sameTopic && routeRef.current.kind === "list") return;
    commitActiveEvent();
    void persistActive();
    activeEvent.current = null;
    setSelectedId(null);
    navigateToList();
    setMobileView("list");
    setMarkAllReadOpen(false);
    resetRenderedStories();
    setListReadSnapshot(new Map(entriesRef.current.map((entry) => [entry.id, entry.status])));
    if (changingSmartFeed || returningToSmartFeed) {
      captureSourceSnapshot(entriesRef.current, entryLabels);
    }
    setPendingNew(0);
    modeRef.current = nextMode;
    topicRef.current = nextTopic;
    hideReadRef.current = nextMode !== "updated" && hideReadByMode[nextMode];
    setMode(nextMode);
    setTopic(nextTopic);
  }, [captureSourceSnapshot, commitActiveEvent, entryLabels, hideReadByMode, navigateToList, persistActive, resetRenderedStories]);

  const frozenVisibleOrder = useMemo(() => {
    const hasQuery = !!query.trim();
    const needle = hasQuery ? query.trim().toLowerCase() : "";
    const filtered = stories.filter((story) => {
      if (!hasQuery && !listReadSnapshot.has(story.id)) return false;
      const statusWhenListed = listReadSnapshot.get(story.id) ?? story.status;
      if (!isEntryInSmartFeed(
        { ...story, status: statusWhenListed },
        mode,
        entryLabels,
      )) return false;
      if (mode !== "updated" && hideRead && statusWhenListed === "read") return false;
      if (topic?.kind === "category" && story.categoryId !== topic.id) return false;
      if (topic?.kind === "feed" && story.feed_id !== topic.id) return false;
      if (!hasQuery) return true;
      return `${story.title} ${story.summary} ${story.source} ${story.author ?? ""}`.toLowerCase().includes(needle);
    });
    const timeBuckets = mode === "today"
      ? new Map(filtered.map((story) => [
        story.id,
        smartFeedTimeBucket(story.published_at, todayClock, activeTimeZone),
      ]))
      : undefined;
    filtered.sort((a, b) => compareSmartFeedEntries(a, b, mode, entryLabels, {
      now: todayClock,
      timeZone: activeTimeZone,
      timeBuckets,
    }));
    return {
      ids: filtered.map((story) => story.id),
      initialEntries: stories,
      initialLabels: entryLabels,
      initialVisible: filtered,
    };
  // The snapshot and context deliberately define when list order is rebuilt.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTimeZone, hideRead, listOrderVersion, listReadSnapshot, mode, query, topic]);

  const visible = useMemo(() => {
    if (
      frozenVisibleOrder.initialEntries === stories
      && frozenVisibleOrder.initialLabels === entryLabels
    ) return frozenVisibleOrder.initialVisible;

    const hasQuery = !!query.trim();
    const needle = hasQuery ? query.trim().toLowerCase() : "";
    const storyById = new Map(stories.map((story) => [story.id, story]));
    return frozenVisibleOrder.ids.flatMap((id) => {
      const story = storyById.get(id);
      if (!story) return [];
      if (!hasQuery && !listReadSnapshot.has(story.id)) return [];
      const statusWhenListed = listReadSnapshot.get(story.id) ?? story.status;
      const wasUpdatedWhenListed = (mode === "today" || mode === "updated")
        && (frozenVisibleOrder.initialLabels.get(story.id)?.includes("updated") ?? false);
      if (!wasUpdatedWhenListed && !isEntryInSmartFeed(
        { ...story, status: statusWhenListed },
        mode,
        entryLabels,
      )) return [];
      if (mode !== "updated" && hideRead && statusWhenListed === "read") return [];
      if (topic?.kind === "category" && story.categoryId !== topic.id) return [];
      if (topic?.kind === "feed" && story.feed_id !== topic.id) return [];
      if (hasQuery && !`${story.title} ${story.summary} ${story.source} ${story.author ?? ""}`.toLowerCase().includes(needle)) return [];
      return [story];
    });
  }, [stories, mode, topic, query, hideRead, listReadSnapshot, frozenVisibleOrder, entryLabels]);
  const visibleMarkReadCount = useMemo(
    () => visible.reduce((count, story) => count + (
      story.status === "unread" || entryLabels.get(story.id)?.includes("updated") ? 1 : 0
    ), 0),
    [entryLabels, visible],
  );
  const renderedStories = useMemo(
    () => visible.slice(0, renderedStoryCount),
    [renderedStoryCount, visible],
  );
  const revealMoreStories = useCallback(() => {
    setRenderedStoryCount((current) => nextStoryRenderCount(current, visible.length));
  }, [visible.length]);

  const markEntriesReadFromScroll = useCallback(async (candidateIds: number[]) => {
    if (!config) return;
    const candidateIdSet = new Set(candidateIds);
    const unreadIds = entriesRef.current.flatMap((entry) => (
      candidateIdSet.has(entry.id)
      && entry.status === "unread"
      && !autoReadPendingIds.current.has(entry.id)
        ? [entry.id]
        : []
    ));
    const updatedIds = candidateIds.filter((id) => (
      entryLabels.get(id)?.includes("updated")
      && !autoReadPendingIds.current.has(id)
    ));
    const affectedIds = [...new Set([...unreadIds, ...updatedIds])];
    if (!affectedIds.length) return;

    affectedIds.forEach((id) => autoReadPendingIds.current.add(id));
    const idSet = new Set(unreadIds);
    const after = replaceEntries((current) => current.map((entry) => (
      idSet.has(entry.id) && entry.status === "unread"
        ? { ...entry, status: "read" as const }
        : entry
    )));
    if (updatedIds.length) {
      setEntryLabels((current) => {
        const next = new Map(current);
        updatedIds.forEach((id) => {
          const labels = (next.get(id) ?? []).filter((label) => label !== "updated");
          if (labels.length) next.set(id, labels);
          else next.delete(id);
        });
        return next;
      });
    }
    try {
      await Promise.all(updatedIds.map((id) => removeEntryLabel(config, id, "updated")));
      if (unreadIds.length) {
        const queued = await queueEntryMutations(
          config,
          after.filter((entry) => idSet.has(entry.id)),
          unreadIds.map((entryId) => ({ entryId, field: "status", value: "read" })),
        );
        rememberQueuedEntryMutations(queued);
        void flushPendingEntryMutations().catch(() => undefined);
      }
    } catch (cause) {
      await Promise.all(updatedIds.map((id) => addEntryLabel(config, id, "updated"))).catch(() => undefined);
      replaceEntries((current) => current.map((entry) => (
        idSet.has(entry.id) && entry.status === "read"
          ? { ...entry, status: "unread" as const }
          : entry
      )));
      if (updatedIds.length) {
        setEntryLabels((current) => {
          const next = new Map(current);
          updatedIds.forEach((id) => {
            const labels = next.get(id) ?? [];
            if (!labels.includes("updated")) next.set(id, [...labels, "updated"]);
          });
          return next;
        });
      }
      notify(errorMessage(cause, t, "errors.sync"));
    } finally {
      affectedIds.forEach((id) => autoReadPendingIds.current.delete(id));
    }
  }, [config, entryLabels, flushPendingEntryMutations, notify, rememberQueuedEntryMutations, replaceEntries, t]);

  const handleStoryListScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const list = event.currentTarget;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 800) revealMoreStories();
    const previousScrollTop = previousStoryListScrollTop.current;
    previousStoryListScrollTop.current = list.scrollTop;
    if (!settings.markReadOnScroll || list.scrollTop <= previousScrollTop) return;

    if (autoReadFrame.current !== undefined) window.cancelAnimationFrame(autoReadFrame.current);
    autoReadFrame.current = window.requestAnimationFrame(() => {
      autoReadFrame.current = undefined;
      if (!list.isConnected) return;
      const passedIds = storyIdsPassedByScroll(
        [...list.querySelectorAll<HTMLElement>(".story[data-entry-id]")].map((story) => ({
          id: Number(story.dataset.entryId),
          offsetTop: story.offsetTop,
          offsetHeight: story.offsetHeight,
        })).filter((story) => Number.isSafeInteger(story.id)),
        list.scrollTop,
      );
      void markEntriesReadFromScroll(passedIds);
    });
  }, [markEntriesReadFromScroll, revealMoreStories, settings.markReadOnScroll]);

  useEffect(() => () => {
    if (autoReadFrame.current !== undefined) window.cancelAnimationFrame(autoReadFrame.current);
  }, []);

  useEffect(() => {
    if (capturedVisibleOrder.current === frozenVisibleOrder.ids) return;
    capturedVisibleOrder.current = frozenVisibleOrder.ids;
    if (mode === "today" && !query.trim() && visible.length) {
      const exposure = createRankingExposure({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        candidateCount: visible.length,
        candidates: visible.slice(0, 50).map((story) => ({
          entryId: story.id,
          breakdown: story.scoreBreakdown,
          statusPriority: smartFeedStatusPriority(story, entryLabels),
        })),
      });
      latestExposure.current = exposure;
      void putRankingExposure(exposure).then(() => {
        setExposures((current) => [...current, exposure]);
        scheduleWebDavUpload();
      }).catch(() => undefined);
    } else {
      latestExposure.current = null;
    }
  }, [visible, frozenVisibleOrder, mode, query, entryLabels, scheduleWebDavUpload]);

  useEffect(() => { visibleEmptyRef.current = !visible.length; }, [visible]);

  const selected = stories.find((story) => story.id === selectedId) ?? null;
  const deferredSelectedId = useDeferredValue(selectedId);
  const readerSelected = deferredSelectedId === selectedId ? selected : null;
  const selectedReadingEvent = readerSelected
    ? events.reduce<ReadingEvent | undefined>((latest, event) => event.entryId === readerSelected.id
      && (!latest || event.openedAt > latest.openedAt) ? event : latest, undefined)
    : undefined;
  const selectedTopicTerms = useMemo(
    () => deferredSelectedId !== null
      ? selectedTopicTermsForEntry(recommendationEvents, deferredSelectedId)
      : new Set<string>(),
    [recommendationEvents, deferredSelectedId],
  );
  const extractedCandidateTerms = readerSelected && activeCandidates?.entryId === readerSelected.id
    ? activeCandidates.terms
    : selectedReadingEvent?.termExtractionVersion ? selectedReadingEvent.terms : [];
  const selectedCandidateTerms = [
    ...selectedTopicTerms,
    ...extractedCandidateTerms.filter((term) => !selectedTopicTerms.has(term)),
  ].slice(0, Math.max(5, selectedTopicTerms.size));
  const selectedReadingSeconds = readerSelected
    ? recommendationEvents.reduce((sum, event) => event.entryId === readerSelected.id ? sum + event.activeSeconds : sum, 0)
    : 0;
  const selectedImageMode = readerSelected
    ? resolveImageLoadingMode(
        settings.imageLoadingPreferences,
        referrerScope,
        readerSelected.feed_id,
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

  const updateEntry = async (id: number, patch: EntryMutationPatch, success: string) => {
    if (!config) return false;
    let mutation: EntryMutation;
    if (patch.status !== undefined) mutation = { entryId: id, field: "status", value: patch.status };
    else if (patch.starred !== undefined) mutation = { entryId: id, field: "starred", value: patch.starred };
    else return false;
    const before = entriesRef.current.find((entry) => entry.id === id);
    if (!before) return false;
    const updated = { ...before, ...patch };
    replaceEntries((all) => all.map((entry) => entry.id === id ? { ...entry, ...patch } : entry));
    try {
      const queued = await queueEntryMutations(config, [updated], [mutation]);
      rememberQueuedEntryMutations(queued);
      void flushPendingEntryMutations().catch(() => undefined);
      notify(success);
      return true;
    } catch (cause) {
      replaceEntries((all) => all.map((entry) => {
        if (entry.id !== id) return entry;
        return {
          ...entry,
          ...(patch.status !== undefined && entry.status === patch.status ? { status: before.status } : {}),
          ...(patch.starred !== undefined && entry.starred === patch.starred ? { starred: before.starred } : {}),
        };
      }));
      notify(errorMessage(cause, t, "errors.sync"));
      return false;
    }
  };

  const toggleStarred = async (story: Story) => {
    if (!config) return;
    const starred = !story.starred;
    const readingEvent = activeEvent.current?.entryId === story.id ? activeEvent.current : null;
    const saved = await updateEntry(
      story.id,
      { starred },
      starred ? t("reader.saved") : t("reader.unsaved"),
    );
    if (!saved || !readingEvent) return;
    const starredAt = new Date().toISOString();
    const updatedEvent = { ...readingEvent, starred, starredAt, updatedAt: starredAt };
    if (activeEvent.current?.id === readingEvent.id) activeEvent.current = updatedEvent;
    await putReadingEvent(updatedEvent);
    setEvents((current) => current.map((event) => event.id === updatedEvent.id ? updatedEvent : event));
    scheduleWebDavUpload();
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
      replaceEntries((all) => all.some((entry) => entry.id === id)
        ? all.map((entry) => entry.id === id ? merged : entry)
        : [...all, merged]);
      await putCachedEntries(config, [merged]);
    } catch (cause) {
      setContentError({
        id,
        error: errorDetails(cause, "reader.contentFailed"),
      });
    } finally {
      setContentLoadingId((current) => current === id ? null : current);
    }
  }, [config, entries, replaceEntries]);

  useEffect(() => {
    if (route.kind !== "article" || !config || loading) return;
    if (entries.some((entry) => entry.id === route.entryId)) return;
    if (contentLoadingId === route.entryId || contentError?.id === route.entryId) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadEntryContent(route.entryId);
    });
    return () => { cancelled = true; };
  }, [route, config, loading, entries, contentLoadingId, contentError, loadEntryContent]);

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
    setTopicSelection(null);
    window.getSelection()?.removeAllRanges();
    navigateToArticle(story.id);
    commitActiveEvent();
    void persistActive();
    setSelectedId(story.id);
    setContentError(null);
    if (!story.content.trim()) void loadEntryContent(story.id);
    readerRef.current?.scrollTo({ top: 0 });
    const eventOrigin = origin ?? (query ? "search" : mode === "today" ? "recommendation" : mode === "saved" ? "saved" : "feed");
    const attribution = eventOrigin === "recommendation" ? rankingAttribution(latestExposure.current, story.id) : {};
    const readingEvent = newReadingEvent({
      entryId: story.id,
      feedId: story.feed_id,
      title: story.title,
      source: story.source,
      terms: [],
      origin: eventOrigin,
      readingTime: story.reading_time,
      listPosition: (() => { const i = visible.findIndex((s) => s.id === story.id); return i >= 0 ? i : undefined; })(),
      ...attribution,
    });
    activeEvent.current = readingEvent;
    setActiveCandidates({ entryId: story.id, terms: [], loading: true });
    const initialPersistence = putReadingEvent(readingEvent);
    void extractRecommendationCandidateTermsAsync(story.title, story.summary).then(async (extracted) => {
      await initialPersistence;
      const prioritizedTerms = prioritizeFollowedTopicTerms(
        story.title,
        story.summary,
        interest.words.keys(),
        extracted.terms,
      );
      const updatedAt = new Date().toISOString();
      let updatedEvent: ReadingEvent | null;
      if (activeEvent.current?.id === readingEvent.id) {
        const terms = [...new Set([...activeEvent.current.terms, ...prioritizedTerms])];
        updatedEvent = {
          ...activeEvent.current,
          terms,
          termExtractionVersion: extracted.version,
          updatedAt,
        };
        activeEvent.current = updatedEvent;
        setActiveCandidates({ entryId: story.id, terms, loading: false });
        await putReadingEvent(updatedEvent);
      } else {
        updatedEvent = await patchReadingEvent(readingEvent.id, {
          terms: prioritizedTerms,
          termExtractionVersion: extracted.version,
          updatedAt,
        });
      }
      if (!updatedEvent) return;
      if (activeEvent.current?.id !== updatedEvent.id) {
        startTransition(() => {
          setEvents((current) => current.some((event) => event.id === updatedEvent.id)
            ? current.map((event) => event.id === updatedEvent.id ? updatedEvent : event)
            : [...current, updatedEvent]);
        });
      }
      scheduleWebDavUpload();
    }).catch(() => {
      if (activeEvent.current?.id === readingEvent.id) {
        setActiveCandidates({ entryId: story.id, terms: [], loading: false });
      }
    });
    if (config && entryLabels.get(story.id)?.includes("updated")) {
      void removeEntryLabel(config, story.id, "updated");
      startTransition(() => {
        setEntryLabels((current) => {
          const next = new Map(current);
          const labels = (next.get(story.id) ?? []).filter((l) => l !== "updated");
          if (labels.length) next.set(story.id, labels);
          else next.delete(story.id);
          return next;
        });
      });
    }
    if (story.status === "unread" && config) {
      startTransition(() => {
        void updateEntry(story.id, { status: "read" }, t("reader.markedRead"));
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, mode, query, visible, persistActive, commitActiveEvent, loadEntryContent, entryLabels, interest, navigateToArticle, t]);

  useEffect(() => {
    if (route.kind === "article") {
      const routedStory = stories.find((story) => story.id === route.entryId);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- route changes control the responsive pane
      setMobileView("reader");
      if (routedStory && selectedId !== routedStory.id) choose(routedStory);
      if (!routedStory && selectedId !== null) {
        commitActiveEvent();
        void persistActive();
        activeEvent.current = null;
        setSelectedId(null);
      }
      return;
    }
    if (mobileView === "reader") {
      setMobileView("list");
    }
    if (selectedId !== null) {
      commitActiveEvent();
      void persistActive();
      activeEvent.current = null;
      setSelectedId(null);
    }
  }, [route, stories, selectedId, mobileView, choose, commitActiveEvent, persistActive]);

  const move = useCallback((delta: number) => {
    if (!visible.length) return;
    const current = visible.findIndex((story) => story.id === selectedId);
    const nextIndex = Math.max(0, Math.min(visible.length - 1, Math.max(0, current) + delta));
    if (nextIndex >= renderedStoryCount) {
      setRenderedStoryCount((count) => nextStoryRenderCount(count, visible.length));
    }
    choose(visible[nextIndex]);
  }, [visible, selectedId, choose, renderedStoryCount]);
  const openStory = useCallback((story: Story) => {
    choose(story);
    setMobileView("reader");
  }, [choose]);

  const toggleRead = useCallback((story: Story) => {
    if (!config) return;
    const status = story.status === "read" ? "unread" : "read";
    void updateEntry(story.id, { status }, status === "read" ? t("reader.markedRead") : t("reader.markedUnread"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, entries, t]);

  const markVisibleRead = useCallback(async () => {
    if (!config) return;
    const ids = visible.filter((story) => story.status === "unread").map((story) => story.id);
    const updatedIds = visible
      .filter((story) => entryLabels.get(story.id)?.includes("updated"))
      .map((story) => story.id);
    const affectedIds = new Set([...ids, ...updatedIds]);
    if (!affectedIds.size) return notify(t("feed.noUnread"));
    const idSet = new Set(ids);
    const before = entries;
    const labelsBefore = entryLabels;
    const after = entries.map((entry) => idSet.has(entry.id) ? { ...entry, status: "read" as const } : entry);
    const labelsAfter = new Map(entryLabels);
    updatedIds.forEach((id) => {
      const labels = (labelsAfter.get(id) ?? []).filter((label) => label !== "updated");
      if (labels.length) labelsAfter.set(id, labels);
      else labelsAfter.delete(id);
    });
    replaceEntries(after);
    setEntryLabels(labelsAfter);
    setListReadSnapshot(new Map(after.map((entry) => [entry.id, entry.status])));
    try {
      await Promise.all(updatedIds.map((id) => removeEntryLabel(config, id, "updated")));
      if (ids.length) {
        const queued = await queueEntryMutations(
          config,
          after.filter((entry) => idSet.has(entry.id)),
          ids.map((entryId) => ({ entryId, field: "status", value: "read" })),
        );
        rememberQueuedEntryMutations(queued);
        void flushPendingEntryMutations().catch(() => undefined);
      }
      const currentExposure = latestExposure.current;
      if (currentExposure && ids.length) {
        const updatedExposure = recordBulkDismissal(currentExposure, ids, new Date().toISOString());
        if (updatedExposure !== currentExposure) {
          latestExposure.current = updatedExposure;
          void putRankingExposure(updatedExposure).then(() => {
            setExposures((current) => current.map((exposure) => exposure.id === updatedExposure.id ? updatedExposure : exposure));
            scheduleWebDavUpload();
          }).catch(() => undefined);
        }
      }
      notify(t("feed.markedRead", { count: affectedIds.size }));
    } catch (cause) {
      await Promise.all(updatedIds.map((id) => addEntryLabel(config, id, "updated"))).catch(() => undefined);
      replaceEntries(before);
      setEntryLabels(labelsBefore);
      setListReadSnapshot(new Map(before.map((entry) => [entry.id, entry.status])));
      notify(errorMessage(cause, t, "errors.sync"));
    }
  }, [config, entries, entryLabels, flushPendingEntryMutations, notify, rememberQueuedEntryMutations, replaceEntries, scheduleWebDavUpload, t, visible]);

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
    if (!visibleMarkReadCount) return notify(t("feed.noUnread"));
    positionMarkAllRead();
    setMarkAllReadOpen(true);
  }, [notify, positionMarkAllRead, t, visibleMarkReadCount]);

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

  const dismissTopicSelection = useCallback((clearSelection = true) => {
    setTopicSelection(null);
    if (clearSelection) window.getSelection()?.removeAllRanges();
  }, []);

  const requestTopicSelection = useCallback((value: string, rect: DOMRect) => {
    const term = normalizeSelectedTopic(value);
    if (!term || selectedTopicTerms.has(term)) {
      setTopicSelection(null);
      return;
    }
    const width = Math.min(112, window.innerWidth - 24);
    const height = 44;
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2));
    const top = Math.max(12, rect.top - height - 10);
    setTopicSelection({
      term,
      top,
      left,
      arrowLeft: Math.max(18, Math.min(width - 18, rect.left + rect.width / 2 - left)),
    });
  }, [selectedTopicTerms]);

  useEffect(() => {
    if (!topicSelection) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        event.preventDefault();
        topicSelectionConfirmRef.current?.focus();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        dismissTopicSelection();
      }
    };
    const dismiss = () => dismissTopicSelection();
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.requestAnimationFrame(() => topicSelectionConfirmRef.current?.focus());
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [dismissTopicSelection, topicSelection]);

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
      if (settingsOpen || markAllReadOpen || topicSelection) return;
      if (["INPUT", "TEXTAREA"].includes((event.target as HTMLElement).tagName)) return;
      if (event.key.toLowerCase() === "j" || event.key === "ArrowDown") move(1);
      if (event.key.toLowerCase() === "k" || event.key === "ArrowUp") move(-1);
      if (event.key.toLowerCase() === "n") {
        const current = visible.findIndex((story) => story.id === selectedId);
        const nextUnread = [...visible.slice(current + 1), ...visible.slice(0, current + 1)].find((story) => story.status === "unread");
        if (nextUnread) choose(nextUnread);
      }
      if (!selected || !config) return;
      if (event.key.toLowerCase() === "s") void toggleStarred(selected);
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
  }, [config, move, selected, entries, visible, selectedId, choose, toggleRead, markAllReadOpen, requestMarkVisibleRead, settingsOpen, topicSelection]);

  const setFeedback = async (feedback: "helpful" | "not_interested") => {
    if (!selected) return;
    if (!activeEvent.current || activeEvent.current.entryId !== selected.id) choose(selected);
    if (activeEvent.current) {
      activeEvent.current.feedback = feedback;
      await persistActive();
    }
    if (feedback === "not_interested") {
      const next = visible.find((story) => story.id !== selected.id);
      if (next) choose(next);
      else navigateToList();
      notify(t("recommendation.reduced"));
    } else {
      notify(t("recommendation.reinforced"));
    }
  };

  const toggleTopicInterest = async (term: string, addToCandidates = false) => {
    if (!selected) return;
    if (!activeEvent.current || activeEvent.current.entryId !== selected.id) choose(selected);
    if (!activeEvent.current) return;
    const normalizedTerm = normalizeRecommendationTerm(term);
    if (!normalizedTerm) return;
    const currentEvent = activeEvent.current;
    const currentlySelected = selectedTopicTermsForEntry([
      ...recommendationEvents.filter((event) => event.id !== currentEvent.id),
      currentEvent,
    ], selected.id).has(normalizedTerm);
    const updatedAt = new Date().toISOString();
    const operation = {
      id: crypto.randomUUID(),
      term: normalizedTerm,
      interested: !currentlySelected,
      updatedAt,
    };
    const terms = addToCandidates && !currentEvent.terms.includes(normalizedTerm)
      ? [normalizedTerm, ...currentEvent.terms]
      : currentEvent.terms;
    const updatedEvent: ReadingEvent = {
      ...currentEvent,
      terms,
      topicFeedback: [...(currentEvent.topicFeedback ?? []), operation],
      updatedAt,
    };
    activeEvent.current = updatedEvent;
    if (addToCandidates) {
      setActiveCandidates((current) => current?.entryId === selected.id
        ? { ...current, terms: [...new Set([normalizedTerm, ...current.terms])], loading: false }
        : { entryId: selected.id, terms: [normalizedTerm], loading: false });
    }
    await putReadingEvent(updatedEvent);
    setEvents((current) => {
      const index = current.findIndex((event) => event.id === updatedEvent.id);
      return index < 0 ? [...current, updatedEvent] : current.map((event, i) => i === index ? updatedEvent : event);
    });
    scheduleWebDavUpload();
    notify(t(operation.interested ? "recommendation.topicSelected" : "recommendation.topicRemoved", { term }));
  };

  const followSelectedTopic = async () => {
    const selection = topicSelection;
    if (!selection) return;
    dismissTopicSelection();
    if (selectedTopicTerms.has(selection.term)) return;
    await toggleTopicInterest(selection.term, true);
  };

  const categorySources = useMemo(() => categories.map((category) => ({
    ...category,
    feeds: feeds.filter((feed) => feed.category?.id === category.id),
  })), [categories, feeds]);
  const countByFeed = useMemo(() => {
    const counts = new Map<number, number>();
    entries.forEach((entry) => {
      if (!sourceSnapshot.statuses.has(entry.id)) return;
      const statusWhenCaptured = sourceSnapshot.statuses.get(entry.id) ?? entry.status;
      if (!isEntryInSmartFeed(
        { ...entry, status: statusWhenCaptured },
        mode,
        sourceSnapshot.labels,
      )) return;
      if (mode !== "updated" && hideRead && statusWhenCaptured !== "unread") return;
      counts.set(entry.feed_id, (counts.get(entry.feed_id) ?? 0) + 1);
    });
    return counts;
  }, [entries, hideRead, mode, sourceSnapshot]);
  const visibleCategorySources = useMemo(() => categorySources.flatMap((category) => {
    const visibleFeeds = category.feeds.filter((feed) =>
      (countByFeed.get(feed.id) ?? 0) > 0
      || topic?.kind === "feed" && topic.id === feed.id,
    );
    const selected = topic?.kind === "category" && topic.id === category.id;
    return visibleFeeds.length || selected || syncProgress
      ? [{ ...category, feeds: syncProgress ? category.feeds : visibleFeeds }]
      : [];
  }), [categorySources, countByFeed, syncProgress, topic]);
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
  const { unreadCount, todayCount, allCount, updatedCount, savedCount } = useMemo(
    () => countSmartFeedEntries(entries, entryLabels),
    [entries, entryLabels],
  );
  const navCounts = useMemo(() => ({
    today: hideReadByMode.today ? unreadCount : todayCount,
    all: hideReadByMode.all ? unreadCount : allCount,
    updated: updatedCount,
    saved: hideReadByMode.saved
      ? entries.reduce((count, entry) => count + (
        entry.status === "unread" && entry.starred ? 1 : 0
      ), 0)
      : savedCount,
  }), [allCount, entries, hideReadByMode, savedCount, todayCount, unreadCount, updatedCount]);
  const syncProgressLabel = syncProgress
    ? `${syncProgress.kind === "search"
      ? t("sync.searching")
      : syncProgress.kind === "incremental"
        ? t("sync.incrementalSyncing")
        : t(syncProgress.phase === "unread" ? "sync.initialUnread" : syncProgress.phase === "starred" ? "sync.initialSaved" : "sync.initialRead")}${syncProgress.total ? ` ${syncProgress.loaded} / ${syncProgress.total}` : ""}`
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
        ? t("sync.fullSyncing")
        : syncedAt
          ? t("feed.syncedAt", { time: formatZonedTime(syncedAt, activeTimeZone) })
          : t("sync.refresh");
  const refreshFeeds = async () => {
    if (refreshInFlight.current || loading) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      const syncSucceeded = await load({ mode: "full" });
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
    ["today", "bi-brightness-high-fill", t("sidebar.today"), navCounts.today],
    ["all", "bi-inbox", t("sidebar.all"), navCounts.all],
    ["updated", "bi-bell", t("sidebar.updated"), navCounts.updated],
    ["saved", "bi-star-fill", t("sidebar.saved"), navCounts.saved],
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
            <nav>{nav.map(([key, icon, label, count]) => {
              const resetsSource = mode === key && topic !== null;
              const nextTopic = mode === key ? null : topic;
              return <button data-sidebar-row key={key} className={mode === key ? "active" : ""} onClick={() => switchListContext(key, nextTopic)} aria-label={resetsSource ? t("sidebar.resetSource", { title: label }) : undefined} title={resetsSource ? t("sidebar.resetSource", { title: label }) : undefined}><i className={`bi ${icon}`} aria-hidden="true" /><span>{label}</span><em>{resetsSource ? "↩" : settings.showFeedArticleCount ? count : ""}</em></button>;
            })}</nav>
            <div className="sideLabel"><span>{t("sidebar.subscriptions")}</span><button type="button" onClick={() => setSubscriptionsCollapsed((current) => !current)} title={t(subscriptionsCollapsed ? "sidebar.expand" : "sidebar.collapse")} aria-label={t(subscriptionsCollapsed ? "sidebar.expand" : "sidebar.collapse")} aria-expanded={!subscriptionsCollapsed}><i className={`bi ${subscriptionsCollapsed ? "bi-chevron-right" : "bi-chevron-down"}`} aria-hidden="true" /></button></div>
            {!subscriptionsCollapsed && visibleCategorySources.map((category) => {
              const collapsed = collapsedCategories.has(category.id);
              const categorySelected = topic?.kind === "category" && topic.id === category.id;
              const categoryCount = category.feeds.reduce((sum, feed) => sum + (countByFeed.get(feed.id) ?? 0), 0);
              return <section className="sourceGroup" key={category.id}>
                <div className={`groupRow ${categorySelected ? "selected" : ""}`}>
                  <button className="disclosure" onClick={() => toggleCategory(category.id)} aria-label={t(collapsed ? "sidebar.expandCategory" : "sidebar.collapseCategory", { title: category.title })} aria-expanded={!collapsed}><i className={`bi ${collapsed ? "bi-folder-fill" : "bi-folder2-open"}`} aria-hidden="true" /></button>
                  <button
                    data-sidebar-row
                    className="groupHead"
                    aria-current={categorySelected ? "page" : undefined}
                    onClick={() => switchListContext(mode, { kind: "category", id: category.id })}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); toggleCategory(category.id, true); }
                      if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); toggleCategory(category.id, false); }
                      if (event.key === " ") { event.preventDefault(); event.stopPropagation(); toggleCategory(category.id); }
                    }}
                  ><span>{category.title}</span><em>{settings.showFeedArticleCount ? categoryCount || "" : ""}</em></button>
                </div>
                {!collapsed && <div className="groupFeeds">
                  {category.feeds.map((feed) => <button data-sidebar-row className={topic?.kind === "feed" && topic.id === feed.id ? "sourceRow selected" : "sourceRow"} key={feed.id} onClick={() => switchListContext(mode, { kind: "feed", id: feed.id })}><SourceIcon src={feedIcons.get(feed.id)}>{feed.title.slice(0, 1)}</SourceIcon><span>{feed.title}</span><em>{settings.showFeedArticleCount ? countByFeed.get(feed.id) || "" : ""}</em></button>)}
                </div>}
              </section>;
            })}
          </div>
        </aside>
        <div className="resizeHandle sidebarHandle" onPointerDown={(event) => startResize("sidebar", event)} onDoubleClick={() => setSidebarWidth(250)} />

        <section className="feed">
          <header className="feedTitle">
            <button className="mobileBack" onClick={() => setMobileView("sources")}>‹ {t("sidebar.feeds")}</button>
            <div className="feedTitleText">
              <h1>{topicTitle ? `${t(`sidebar.${mode}`)} · ${topicTitle}` : t(`sidebar.${mode}`)}</h1>
              {(settings.showFeedArticleCount || error && entries.length > 0) && <small>
                {settings.showFeedArticleCount
                  ? t(mode === "today" ? "feed.recommendedCount" : mode === "updated" ? "feed.updatedCount" : "feed.articleCount", { count: visible.length })
                  : ""}
                {settings.showFeedArticleCount && error && entries.length ? " · " : ""}
                {error && entries.length ? t("feed.offline") : ""}
              </small>}
            </div>
            <div className="feedTitleActions" role="group" aria-label={t("feed.listActions")}>
              <button ref={markAllReadButtonRef} type="button" className={markAllReadOpen ? "markAllReadSpotlight" : ""} onClick={requestMarkVisibleRead} disabled={!visibleMarkReadCount} aria-label={t("feed.markAllRead")} title={t("feed.markAllRead")}><i className="bi bi-check2-all" aria-hidden="true" /></button>
              <button type="button" className={hideRead ? "active" : ""} disabled={mode === "updated"} onClick={() => { if (mode === "updated") return; resetRenderedStories(); setListReadSnapshot(new Map(entries.map((entry) => [entry.id, entry.status]))); setHideReadByMode((current) => ({ ...current, [mode]: !current[mode] })); }} aria-label={t("feed.unreadOnly")} title={t(mode === "updated" ? "feed.unreadOnly" : hideRead ? "feed.showAll" : "feed.unreadOnly")} aria-pressed={hideRead}><i className="bi bi-filter-circle" aria-hidden="true" /></button>
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
              <h2 id="mark-all-read-title">{t("feed.markAllReadConfirm", { count: visibleMarkReadCount })}</h2>
              <button ref={markAllReadConfirmRef} type="button" onClick={() => { setMarkAllReadOpen(false); void markVisibleRead(); }}>{t("common.confirm")}</button>
            </section>
          </>}
          <div className="storyList" ref={storyListRef} onScroll={handleStoryListScroll}>
            {pendingNew > 0 && <button className="newArticlesPill" onClick={refreshList}>{t("feed.newArticles", { count: pendingNew })}</button>}
            {visible.length ? <>{renderedStories.map((story) => <StoryRow
              key={story.id}
              story={story}
              selected={selected?.id === story.id}
              updated={story.status === "read" && (entryLabels.get(story.id)?.includes("updated") ?? false)}
              feedIcon={feedIcons.get(story.feed_id)}
              todayClock={todayClock}
              timeZone={activeTimeZone}
              locale={i18n.resolvedLanguage ?? "en"}
              onChoose={openStory}
              t={t}
            />)}{renderedStories.length < visible.length && <button className="storyListMore" type="button" onClick={revealMoreStories}>{t("feed.showMore", { count: Math.min(STORY_RENDER_BATCH_SIZE, visible.length - renderedStories.length) })}</button>}</> : null}
          </div>
          {!visible.length && (loading && !entries.length
            ? <div className="empty storyListState"><b className="loadingMark">↻</b><h2>{t("feed.syncing")}</h2><p>{t("feed.syncingHint")}</p></div>
            : error && !entries.length
              ? <div className="empty storyListState errorState"><b>!</b><h2>{t("feed.connectionFailed")}</h2><p>{t(error.key, { status: error.status })}</p><button onClick={() => void load()}>{t("feed.reconnect")}</button></div>
              : <div className="empty storyListState"><b>✓</b><h2>{t("feed.empty")}</h2><p>{t("feed.emptyHint")}</p></div>)}
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
              <div className="readerToolbar"><button className="mobileBack" onClick={() => { navigateToList(); setMobileView("list"); }}>‹ {t("reader.backToArticles")}</button><div><button onClick={() => toggleRead(selected)} title={t(selected.status === "read" ? "reader.markUnread" : "reader.markRead")}>{selected.status === "read" ? "○" : "●"}</button><button className={selected.starred ? "pressed" : ""} title={t(selected.starred ? "reader.unsave" : "reader.save")} onClick={() => void toggleStarred(selected)}>{selected.starred ? "★" : "☆"}</button><a href={selected.url} target="_blank" rel="noopener noreferrer" title={t("reader.openOriginal")}>↗</a><button title={t("reader.copyLink")} onClick={async () => { await navigator.clipboard.writeText(selected.url); notify(t("reader.linkCopied")); }}>⧉</button><button title={t("reader.notInterested")} onClick={() => void setFeedback("not_interested")}>−</button></div></div>
              <p className="crumb">{selected.category} · {selected.source}</p>
              <ArticleMetadata
                key={`${selected.id}:${selectedReadingSeconds}`}
                story={selected}
                feedIcon={feedIcons.get(selected.feed_id)}
                timeZone={activeTimeZone}
                initialReadingSeconds={selectedReadingSeconds}
                onReadingTick={recordReadingTick}
                onTextSelection={requestTopicSelection}
                t={t}
              />
              {readerSelected && (activeCandidates?.entryId === selected.id && activeCandidates.loading ? <section className="topicPicker topicPickerLoading" aria-live="polite">
                <div><strong>{t("recommendation.candidateTopics")}</strong><small>{t("recommendation.extractingTopics")}</small></div>
              </section> : selectedCandidateTerms.length > 0 && <section className="topicPicker" aria-labelledby="topic-picker-title">
                <div><strong id="topic-picker-title">{t("recommendation.candidateTopics")}</strong><small>{t("recommendation.candidateTopicsHint")}</small></div>
                <div>{selectedCandidateTerms.map((term) => {
                  const selectedTopic = selectedTopicTerms.has(term);
                  return <button key={term} className={selectedTopic ? "selected" : ""} aria-pressed={selectedTopic} onClick={() => void toggleTopicInterest(term)}>{selectedTopic ? "✓ " : "+ "}{term}</button>;
                })}</div>
              </section>)}
              <section className="reason">
                <button className="reasonHead" onClick={() => setReasonOpen(!reasonOpen)}><span>{t("recommendation.reason")}</span><small>{reasonOpen ? t("recommendation.collapse") : t("recommendation.view")}</small></button>
                {reasonOpen && <><p>{selected.reason}</p><div className="tags">{[selected.category, selected.source, ...(selected.tags ?? [])].slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}</div></>}
              </section>
              {readerSelected?.id !== selected.id
                ? <div className="articleLoading" role="status"><b className="loadingMark">↻</b><p>{t("reader.loadingContent")}</p></div>
                : contentLoadingId === selected.id
                ? <div className="articleLoading" role="status"><b className="loadingMark">↻</b><p>{t("reader.loadingContent")}</p></div>
                : contentError?.id === selected.id
                  ? <div className="articleLoading errorState"><b>!</b><p>{t(contentError.error.key, { status: contentError.error.status })}</p><button onClick={() => void loadEntryContent(selected.id)}>{t("common.retry")}</button></div>
                  : <ArticleBody
                      content={readerSelected.content}
                      minifluxURL={config.url}
                      imageMode={selectedImageMode}
                      onTextSelection={requestTopicSelection}
                    />}
              <div className="feedback"><span>{t("recommendation.feedbackQuestion")}</span><button onClick={() => void setFeedback("helpful")}>{t("recommendation.helpful")}</button><button onClick={() => void setFeedback("not_interested")}>{t("recommendation.notInterested")}</button></div>
            </div>
            {topicSelection && <>
              <div className="topicSelectionBackdrop" role="presentation" onMouseDown={() => dismissTopicSelection()} />
              <section
                className="topicSelectionConfirm"
                role="dialog"
                aria-modal="true"
                aria-label={t("recommendation.followSelectedTopic")}
                style={{
                  top: topicSelection.top,
                  left: topicSelection.left,
                  "--topic-selection-arrow-left": `${topicSelection.arrowLeft}px`,
                } as CSSProperties}
              >
                <button ref={topicSelectionConfirmRef} type="button" onClick={() => void followSelectedTopic()}>{t("recommendation.followSelectedTopic")}</button>
              </section>
            </>}
          </> : route.kind === "article" ? <div className={`empty readerEmpty ${contentError?.id === route.entryId ? "errorState" : ""}`}>
            <b className={contentError?.id === route.entryId ? "" : "loadingMark"}>{contentError?.id === route.entryId ? "!" : "↻"}</b>
            <h2>{t(contentError?.id === route.entryId ? "reader.contentFailed" : "reader.loadingContent")}</h2>
            {contentError?.id === route.entryId && <p>{t(contentError.error.key, { status: contentError.error.status })}</p>}
            <div>{contentError?.id === route.entryId && <button onClick={() => void loadEntryContent(route.entryId)}>{t("common.retry")}</button>}<button onClick={navigateToList}>{t("reader.backToArticles")}</button></div>
          </div> : <div className="empty readerEmpty"><b>☷</b><h2>{t("reader.select")}</h2><p>{t("reader.selectHint")}</p></div>}
        </article>
      </div>

      {settingsOpen && <SettingsDialog
        config={config}
        feeds={feeds}
        referrerScope={referrerScope}
        imageProxyAvailable={imageProxyAvailable}
        events={recommendationEvents}
        settings={settings}
        timeZone={activeTimeZone}
        timeZoneSource={timeZoneSelection.source}
        sourceWeights={interest.sources}
        wordWeights={interest.words}
        exposures={recommendationExposures}
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
          setEvents(next.filter((event) => !event.remoteClientId));
        }}
        webDavConfig={webDavConfig}
        webDavStatus={webDavStatus}
        onSaveWebDav={handleSaveWebDav}
        onSyncWebDav={runWebDavSync}
        onDisconnectWebDav={handleDisconnectWebDav}
        onDisconnect={() => {
          clearConnection();
          setSettingsOpen(false);
          setConfig(null);
        }}
        onSyncEntries={async () => {
          const succeeded = await load({ mode: "full" });
          if (succeeded) {
            refreshList();
            notify(t("sync.refreshDone"));
          } else {
            notify(t("sync.refreshFailed"));
          }
        }}
        onResetSync={async () => {
          syncResetInProgress.current = true;
          resetRenderedStories();
          try {
            while (syncInFlight.current) {
              await new Promise((resolve) => window.setTimeout(resolve, 50));
            }
            await resetEntrySync(config);
            syncStateRef.current = null;
            sourceSnapshotInitialized.current = false;
            setSourceSnapshot({ statuses: new Map(), labels: new Map() });
            replaceEntries([]);
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
          await load({ mode: "full" });
        }}
        syncBusy={loading}
        notify={notify}
      />}
      {toast && <div className="toast">✓　{toast}</div>}
    </main>
  );
}
