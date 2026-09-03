import {
  isImageLoadingMode,
  type ImageLoadingMode,
  type ImageLoadingPreferences,
} from "./article-images.ts";
import { isSupportedLanguage, type SupportedLanguage } from "./languages.ts";

export type ConnectionConfig = {
  url: string;
  apiKey: string;
  timeZone?: string;
};

export type ThemeName = "day" | "night";

export type MinifluxSyncInterval = 0 | 30 | 60 | 120 | 240 | 480;

export const DEFAULT_INCREMENTAL_SYNC_INTERVAL: MinifluxSyncInterval = 30;
export const DEFAULT_FULL_SYNC_INTERVAL: MinifluxSyncInterval = 240;

export type ProfileSettings = {
  theme: ThemeName;
  language?: SupportedLanguage;
  showFeedArticleCount: boolean;
  markReadOnScroll: boolean;
  imageLoadingPreferences: ImageLoadingPreferences;
  incrementalSyncIntervalMinutes: MinifluxSyncInterval;
  fullSyncIntervalMinutes: MinifluxSyncInterval;
  updatedAt: string;
};

type StoredProfileSettings = Partial<ProfileSettings> & {
  originReferrerFeeds?: Record<string, number[]>;
  webdav?: unknown;
};

export type EntrySyncPhase = "unread" | "starred" | "read";

export type EntrySyncState = {
  initialSyncComplete: boolean;
  phase?: EntrySyncPhase;
  offset?: number;
  incrementalCursor?: string;
  lastIncrementalSyncAt?: string;
  lastFullSyncAt?: string;
  /** Legacy full-sync completion timestamp. */
  updatedAt?: string;
};

export type EntryMutation =
  | { entryId: number; field: "status"; value: "read" | "unread" }
  | { entryId: number; field: "starred"; value: boolean };

export type StoredEntryMutation = EntryMutation & {
  key: string;
  revision: string;
  state: "pending" | "sending";
  updatedAt: string;
};

export type CachedFeedIcon = {
  feedId: number;
  iconId: number;
  src: string;
};

/**
 * Sidebar metadata kept locally so a cold start can render feeds and
 * categories without waiting on Miniflux.
 */
export type CachedFeedCatalog<F = unknown, C = unknown> = {
  feeds: F[];
  categories: C[];
  savedAt: string;
};

export type ReadingEvent = {
  id: string;
  entryId: number;
  feedId: number;
  title: string;
  source: string;
  terms: string[];
  termExtractionVersion?: string;
  topicFeedback?: TopicFeedbackOperation[];
  openedAt: string;
  activeSeconds: number;
  scrollDepth: number;
  origin: "recommendation" | "feed" | "search" | "saved";
  feedback?: "helpful" | "not_interested";
  readingTime?: number;
  listPosition?: number;
  rankingId?: string;
  exposedRank?: number;
  algorithmVersion?: string;
  starred?: boolean;
  starredAt?: string;
  updatedAt: string;
  remoteClientId?: string;
  remoteClientName?: string;
};

export type TopicFeedbackOperation = {
  id: string;
  term: string;
  interested: boolean;
  updatedAt: string;
};

export type RankingExposureItem = {
  entryId: number;
  rank: number;
  score: number;
  sourceScore: number;
  termScore: number;
  freshnessScore: number;
  savedBonus: number;
  negativePenalty: number;
  statusPriority: number;
  matchedTerms: string[];
};

export type RankingExposure = {
  id: string;
  createdAt: string;
  algorithmVersion: string;
  schemaVersion: 1 | 2;
  surface: "today";
  candidateCount: number;
  displayedCount: number;
  items: RankingExposureItem[];
  bulkDismissedAt?: string;
  bulkDismissedEntryIds?: number[];
  remoteClientId?: string;
  remoteClientName?: string;
};

export type WebDavSyncInterval = 0 | 5 | 15 | 30 | 60;

export type WebDavConfig = {
  url: string;
  username: string;
  password: string;
  clientName: string;
  intervalMinutes: WebDavSyncInterval;
};

const LOCAL_CONFIG = "readflux.miniflux.local";
const PREFERENCES = "readflux.preferences";
const DB_NAME = "readflux-profile";
const DB_VERSION = 9;
const EVENTS = "reading-events";
const SETTINGS = "settings";
const ARTICLES = "articles";
const ARTICLE_STATE = "article-state";
const FEED_ICONS = "feed-icons";
const FEED_CATALOG = "feed-catalog";
const SYNC_STATE = "sync-state";
const OUTBOX = "outbox";
const LEGACY_ENTRY_CACHE = "entry-cache";
const LEGACY_ENTRY_LABELS = "entry-labels";
const LEGACY_ENTRY_MUTATIONS = "entry-mutations";
const REMOTE_EVENTS = "remote-reading-events";
const RANKING_EXPOSURES = "ranking-exposures";
const REMOTE_RANKING_EXPOSURES = "remote-ranking-exposures";
const WEBDAV_CONFIG = "readflux.webdav";
const WEBDAV_CLIENT_ID = "readflux.webdav.client-id";
const WEBDAV_CLIENT_CREATED_AT = "readflux.webdav.client-created-at";
const WEBDAV_DIRTY_MONTHS = "webdav-dirty-months";
const WEBDAV_DIRTY_EXPOSURE_MONTHS = "webdav-dirty-exposure-months";

type CacheableEntry = {
  id: number;
  status: "read" | "unread" | "removed";
  starred: boolean;
  updated?: boolean;
};

type ArticleRecord<T extends CacheableEntry = CacheableEntry> = {
  id: number;
  article: Omit<T, "id" | "status" | "starred" | "updated">;
};

type ArticleStateRecord = {
  entryId: number;
  status: CacheableEntry["status"];
  starred: boolean;
  updated: boolean;
};

type FeedCatalogRecord<F = unknown, C = unknown> = CachedFeedCatalog<F, C> & {
  id: "catalog";
};

type RemoteEventRecord = {
  key: string;
  sourceMonth: string;
  clientId: string;
  month: string;
  event: ReadingEvent;
};

type RemoteExposureRecord = {
  key: string;
  sourceMonth: string;
  clientId: string;
  month: string;
  exposure: RankingExposure;
};

export function getConnection(): ConnectionConfig | null {
  if (typeof window === "undefined") return null;
  const value = localStorage.getItem(LOCAL_CONFIG);
  if (!value) return null;
  try {
    const config = JSON.parse(value) as Partial<ConnectionConfig>;
    if (!config.url || !config.apiKey) throw new Error("Invalid connection");
    return {
      url: config.url,
      apiKey: config.apiKey,
      ...(typeof config.timeZone === "string" && config.timeZone ? { timeZone: config.timeZone } : {}),
    };
  } catch {
    localStorage.removeItem(LOCAL_CONFIG);
    return null;
  }
}

export function saveConnection(config: ConnectionConfig) {
  localStorage.setItem(LOCAL_CONFIG, JSON.stringify(config));
}

export function clearConnection() {
  localStorage.removeItem(LOCAL_CONFIG);
}

export class MinifluxRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Miniflux request failed (${status})`);
    this.name = "MinifluxRequestError";
    this.status = status;
  }
}

export async function minifluxFetch<T>(
  config: ConnectionConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${config.url.replace(/\/+$/, "")}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": config.apiKey,
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new MinifluxRequestError(response.status);
  }
  if (response.status === 204) return null as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EVENTS)) {
        const store = db.createObjectStore(EVENTS, { keyPath: "id" });
        store.createIndex("entryId", "entryId");
        store.createIndex("openedAt", "openedAt");
      }
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS);
      if (db.objectStoreNames.contains(LEGACY_ENTRY_CACHE)) db.deleteObjectStore(LEGACY_ENTRY_CACHE);
      if (db.objectStoreNames.contains(LEGACY_ENTRY_LABELS)) db.deleteObjectStore(LEGACY_ENTRY_LABELS);
      if (db.objectStoreNames.contains(FEED_ICONS)) db.deleteObjectStore(FEED_ICONS);
      if (!db.objectStoreNames.contains(ARTICLES)) db.createObjectStore(ARTICLES, { keyPath: "id" });
      if (!db.objectStoreNames.contains(ARTICLE_STATE)) db.createObjectStore(ARTICLE_STATE, { keyPath: "entryId" });
      if (!db.objectStoreNames.contains(FEED_ICONS)) db.createObjectStore(FEED_ICONS, { keyPath: "feedId" });
      if (!db.objectStoreNames.contains(FEED_CATALOG)) db.createObjectStore(FEED_CATALOG, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SYNC_STATE)) db.createObjectStore(SYNC_STATE, { keyPath: "id" });
      if (db.objectStoreNames.contains(LEGACY_ENTRY_MUTATIONS)) {
        const legacyStore = request.transaction!.objectStore(LEGACY_ENTRY_MUTATIONS);
        const outbox = db.createObjectStore(OUTBOX, { keyPath: "key" });
        const legacyMutations = legacyStore.getAll();
        legacyMutations.onsuccess = () => {
          (legacyMutations.result as StoredEntryMutation[]).forEach((mutation) => {
            outbox.put({
              key: `${mutation.entryId}:${mutation.field}`,
              entryId: mutation.entryId,
              field: mutation.field,
              value: mutation.value,
              revision: mutation.revision,
              state: mutation.state,
              updatedAt: mutation.updatedAt,
            });
          });
          db.deleteObjectStore(LEGACY_ENTRY_MUTATIONS);
        };
      } else if (!db.objectStoreNames.contains(OUTBOX)) {
        db.createObjectStore(OUTBOX, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(REMOTE_EVENTS)) {
        const store = db.createObjectStore(REMOTE_EVENTS, { keyPath: "key" });
        store.createIndex("sourceMonth", "sourceMonth");
        store.createIndex("clientId", "clientId");
      }
      if (!db.objectStoreNames.contains(RANKING_EXPOSURES)) {
        const store = db.createObjectStore(RANKING_EXPOSURES, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(REMOTE_RANKING_EXPOSURES)) {
        const store = db.createObjectStore(REMOTE_RANKING_EXPOSURES, { keyPath: "key" });
        store.createIndex("sourceMonth", "sourceMonth");
        store.createIndex("clientId", "clientId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function getCachedEntries<T extends CacheableEntry>(): Promise<T[]> {
  const db = await openDb();
  const transaction = db.transaction([ARTICLES, ARTICLE_STATE]);
  const [articles, states] = await Promise.all([
    requestResult(transaction.objectStore(ARTICLES).getAll()) as Promise<ArticleRecord<T>[]>,
    requestResult(transaction.objectStore(ARTICLE_STATE).getAll()) as Promise<ArticleStateRecord[]>,
  ]);
  db.close();
  const stateById = new Map(states.map((state) => [state.entryId, state]));
  return articles.map(({ id, article }) => {
    const state = stateById.get(id);
    return {
      ...article,
      id,
      status: state?.status ?? "unread",
      starred: state?.starred ?? false,
      ...(state?.updated ? { updated: true } : {}),
    } as T;
  });
}

export async function putCachedEntries<T extends CacheableEntry>(entries: T[]) {
  if (!entries.length) return;
  const db = await openDb();
  const transaction = db.transaction([ARTICLES, ARTICLE_STATE], "readwrite");
  const articleStore = transaction.objectStore(ARTICLES);
  const stateStore = transaction.objectStore(ARTICLE_STATE);
  entries.forEach((entry) => {
    const { id, status, starred, updated, ...article } = entry;
    articleStore.put({ id, article });
    stateStore.put({ entryId: id, status, starred, updated: updated === true } satisfies ArticleStateRecord);
  });
  await transactionComplete(transaction);
  db.close();
}

export async function setArticleUpdated(entryIds: number[], updated: boolean) {
  if (!entryIds.length) return;
  const db = await openDb();
  const transaction = db.transaction(ARTICLE_STATE, "readwrite");
  const store = transaction.objectStore(ARTICLE_STATE);
  await Promise.all(entryIds.map(async (entryId) => {
    const current = await requestResult(store.get(entryId)) as ArticleStateRecord | undefined;
    if (current) store.put({ ...current, updated });
  }));
  await transactionComplete(transaction);
  db.close();
}

export async function getEntryMutations(): Promise<StoredEntryMutation[]> {
  const db = await openDb();
  const mutations = await requestResult(db.transaction(OUTBOX).objectStore(OUTBOX).getAll()) as StoredEntryMutation[];
  db.close();
  return mutations;
}

export async function queueEntryMutations<T extends CacheableEntry>(
  entries: T[],
  mutations: EntryMutation[],
) {
  if (!mutations.length) return [];
  const db = await openDb();
  const transaction = db.transaction([ARTICLE_STATE, OUTBOX], "readwrite");
  const stateStore = transaction.objectStore(ARTICLE_STATE);
  entries.forEach((entry) => {
    stateStore.put({
      entryId: entry.id,
      status: entry.status,
      starred: entry.starred,
      updated: entry.updated === true,
    } satisfies ArticleStateRecord);
  });
  const now = new Date().toISOString();
  const records = mutations.map((mutation): StoredEntryMutation => ({
    ...mutation,
    key: `${mutation.entryId}:${mutation.field}`,
    revision: crypto.randomUUID(),
    state: "pending",
    updatedAt: now,
  }));
  const mutationStore = transaction.objectStore(OUTBOX);
  records.forEach((record) => mutationStore.put(record));
  await transactionComplete(transaction);
  db.close();
  return records;
}

export async function claimEntryMutations(): Promise<StoredEntryMutation[]> {
  const db = await openDb();
  const transaction = db.transaction(OUTBOX, "readwrite");
  const store = transaction.objectStore(OUTBOX);
  const records = await requestResult(store.getAll()) as StoredEntryMutation[];
  const claimed = records.map((record) => ({ ...record, state: "sending" as const }));
  claimed.forEach((record) => store.put(record));
  await transactionComplete(transaction);
  db.close();
  return claimed;
}

async function updateClaimedEntryMutations(
  claimed: StoredEntryMutation[],
  action: "complete" | "retry",
) {
  if (!claimed.length) return;
  const db = await openDb();
  const transaction = db.transaction(OUTBOX, "readwrite");
  const store = transaction.objectStore(OUTBOX);
  await Promise.all(claimed.map(async (mutation) => {
    const current = await requestResult(store.get(mutation.key)) as StoredEntryMutation | undefined;
    if (current?.revision !== mutation.revision) return;
    if (action === "complete") store.delete(mutation.key);
    else store.put({ ...current, state: "pending" });
  }));
  await transactionComplete(transaction);
  db.close();
}

export async function completeEntryMutations(claimed: StoredEntryMutation[]) {
  await updateClaimedEntryMutations(claimed, "complete");
}

export async function retryEntryMutations(claimed: StoredEntryMutation[]) {
  await updateClaimedEntryMutations(claimed, "retry");
}

export async function getCachedFeedIcons(): Promise<CachedFeedIcon[]> {
  const db = await openDb();
  const records = await requestResult(db.transaction(FEED_ICONS).objectStore(FEED_ICONS).getAll()) as CachedFeedIcon[];
  db.close();
  return records;
}

export async function putCachedFeedIcons(icons: CachedFeedIcon[]) {
  if (!icons.length) return;
  const db = await openDb();
  const transaction = db.transaction(FEED_ICONS, "readwrite");
  const store = transaction.objectStore(FEED_ICONS);
  icons.forEach((icon) => store.put(icon));
  await transactionComplete(transaction);
  db.close();
}

export async function getCachedFeedCatalog<F, C>(): Promise<CachedFeedCatalog<F, C> | null> {
  const db = await openDb();
  const value = await requestResult(db.transaction(FEED_CATALOG).objectStore(FEED_CATALOG).get("catalog"));
  db.close();
  if (!value || typeof value !== "object") return null;
  const catalog = value as FeedCatalogRecord<F, C>;
  if (!Array.isArray(catalog.feeds) || !Array.isArray(catalog.categories)) return null;
  return { feeds: catalog.feeds, categories: catalog.categories, savedAt: catalog.savedAt };
}

export async function saveCachedFeedCatalog<F, C>(
  catalog: Omit<CachedFeedCatalog<F, C>, "savedAt">,
) {
  const db = await openDb();
  const transaction = db.transaction(FEED_CATALOG, "readwrite");
  const record: FeedCatalogRecord<F, C> = { id: "catalog", ...catalog, savedAt: new Date().toISOString() };
  transaction.objectStore(FEED_CATALOG).put(record);
  await transactionComplete(transaction);
  db.close();
}

export async function getEntrySyncState(): Promise<EntrySyncState | null> {
  const db = await openDb();
  const value = await requestResult(db.transaction(SYNC_STATE).objectStore(SYNC_STATE).get("sync"));
  db.close();
  return value && typeof value === "object" ? value as EntrySyncState : null;
}

export async function saveEntrySyncState(state: EntrySyncState) {
  const db = await openDb();
  const transaction = db.transaction(SYNC_STATE, "readwrite");
  transaction.objectStore(SYNC_STATE).put({ id: "sync", ...state });
  await transactionComplete(transaction);
  db.close();
}

export async function resetEntrySync() {
  const db = await openDb();
  const transaction = db.transaction([ARTICLES, ARTICLE_STATE, FEED_ICONS, FEED_CATALOG, SYNC_STATE], "readwrite");
  [ARTICLES, ARTICLE_STATE, FEED_ICONS, FEED_CATALOG, SYNC_STATE].forEach((storeName) => {
    transaction.objectStore(storeName).clear();
  });
  await transactionComplete(transaction);
  db.close();
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getReadingEvents(): Promise<ReadingEvent[]> {
  const db = await openDb();
  const events = await requestResult(db.transaction(EVENTS).objectStore(EVENTS).getAll());
  db.close();
  return events as ReadingEvent[];
}

export function readingEventMonth(event: Pick<ReadingEvent, "openedAt">) {
  return event.openedAt.slice(0, 7);
}

export function rankingExposureMonth(exposure: Pick<RankingExposure, "createdAt">) {
  return exposure.createdAt.slice(0, 7);
}

async function addDirtyMonths(store: IDBObjectStore, months: string[]) {
  const current = await requestResult(store.get(WEBDAV_DIRTY_MONTHS)) as string[] | undefined;
  store.put([...new Set([...(current ?? []), ...months.filter(Boolean)])].sort(), WEBDAV_DIRTY_MONTHS);
}

export async function claimDirtyReadingEventMonths(): Promise<string[]> {
  const db = await openDb();
  const transaction = db.transaction(SETTINGS, "readwrite");
  const store = transaction.objectStore(SETTINGS);
  const value = await requestResult(store.get(WEBDAV_DIRTY_MONTHS));
  const months = Array.isArray(value) ? value.filter((month): month is string => typeof month === "string") : [];
  store.put([], WEBDAV_DIRTY_MONTHS);
  await transactionComplete(transaction);
  db.close();
  return months;
}

export async function markReadingEventMonthsDirty(months: string[]) {
  if (!months.length) return;
  const db = await openDb();
  const transaction = db.transaction(SETTINGS, "readwrite");
  await addDirtyMonths(transaction.objectStore(SETTINGS), months);
  await transactionComplete(transaction);
  db.close();
}

export async function markAllReadingEventMonthsDirty() {
  const events = await getReadingEvents();
  const db = await openDb();
  const transaction = db.transaction(SETTINGS, "readwrite");
  await addDirtyMonths(transaction.objectStore(SETTINGS), events.map(readingEventMonth));
  await transactionComplete(transaction);
  db.close();
}

export async function claimDirtyRankingExposureMonths(): Promise<string[]> {
  const db = await openDb();
  const transaction = db.transaction(SETTINGS, "readwrite");
  const store = transaction.objectStore(SETTINGS);
  const value = await requestResult(store.get(WEBDAV_DIRTY_EXPOSURE_MONTHS));
  const months = Array.isArray(value) ? value.filter((month): month is string => typeof month === "string") : [];
  store.put([], WEBDAV_DIRTY_EXPOSURE_MONTHS);
  await transactionComplete(transaction);
  db.close();
  return months;
}

export async function markRankingExposureMonthsDirty(months: string[]) {
  if (!months.length) return;
  const db = await openDb();
  const transaction = db.transaction(SETTINGS, "readwrite");
  const store = transaction.objectStore(SETTINGS);
  const current = await requestResult(store.get(WEBDAV_DIRTY_EXPOSURE_MONTHS)) as string[] | undefined;
  store.put([...new Set([...(current ?? []), ...months.filter(Boolean)])].sort(), WEBDAV_DIRTY_EXPOSURE_MONTHS);
  await transactionComplete(transaction);
  db.close();
}

export async function markAllRankingExposureMonthsDirty() {
  const exposures = await getRankingExposures();
  await markRankingExposureMonthsDirty(exposures.map(rankingExposureMonth));
}

export function normalizeReadingEventOpenedAt(value: string): string | null {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

export async function putReadingEvent(event: ReadingEvent) {
  const db = await openDb();
  const tx = db.transaction([EVENTS, SETTINGS], "readwrite");
  const store = tx.objectStore(EVENTS);
  const previous = await requestResult(store.get(event.id)) as ReadingEvent | undefined;
  const localEvent = { ...event };
  delete localEvent.remoteClientId;
  delete localEvent.remoteClientName;
  store.put(localEvent);
  await addDirtyMonths(tx.objectStore(SETTINGS), [readingEventMonth(event), ...(previous ? [readingEventMonth(previous)] : [])]);
  await transactionComplete(tx);
  db.close();
}

export async function patchReadingEvent(id: string, patch: Partial<ReadingEvent>): Promise<ReadingEvent | null> {
  const db = await openDb();
  const tx = db.transaction([EVENTS, SETTINGS], "readwrite");
  const store = tx.objectStore(EVENTS);
  const previous = await requestResult(store.get(id)) as ReadingEvent | undefined;
  if (!previous) {
    await transactionComplete(tx);
    db.close();
    return null;
  }
  const updated = { ...previous, ...patch, id: previous.id };
  delete updated.remoteClientId;
  delete updated.remoteClientName;
  store.put(updated);
  await addDirtyMonths(tx.objectStore(SETTINGS), [readingEventMonth(previous), readingEventMonth(updated)]);
  await transactionComplete(tx);
  db.close();
  return updated;
}

export async function deleteReadingEvent(id: string) {
  const db = await openDb();
  const tx = db.transaction([EVENTS, SETTINGS], "readwrite");
  const store = tx.objectStore(EVENTS);
  const previous = await requestResult(store.get(id)) as ReadingEvent | undefined;
  store.delete(id);
  if (previous) await addDirtyMonths(tx.objectStore(SETTINGS), [readingEventMonth(previous)]);
  await transactionComplete(tx);
  db.close();
}

export function getWebDavConfig(): WebDavConfig | null {
  if (typeof window === "undefined") return null;
  const value = localStorage.getItem(WEBDAV_CONFIG);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<WebDavConfig>;
    if (!parsed.url || typeof parsed.username !== "string" || typeof parsed.password !== "string") return null;
    const interval = Number(parsed.intervalMinutes);
    return {
      url: parsed.url,
      username: parsed.username,
      password: parsed.password,
      clientName: parsed.clientName?.trim() || "ReadFlux",
      intervalMinutes: ([0, 5, 15, 30, 60].includes(interval) ? interval : 15) as WebDavSyncInterval,
    };
  } catch {
    localStorage.removeItem(WEBDAV_CONFIG);
    return null;
  }
}

export function saveWebDavConfig(config: WebDavConfig) {
  localStorage.setItem(WEBDAV_CONFIG, JSON.stringify(config));
}

export function clearWebDavConfig() {
  localStorage.removeItem(WEBDAV_CONFIG);
}

export function getWebDavClientId() {
  let id = localStorage.getItem(WEBDAV_CLIENT_ID);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(WEBDAV_CLIENT_ID, id);
  }
  return id;
}

export function getWebDavClientCreatedAt() {
  let createdAt = localStorage.getItem(WEBDAV_CLIENT_CREATED_AT);
  if (!createdAt) {
    createdAt = new Date().toISOString();
    localStorage.setItem(WEBDAV_CLIENT_CREATED_AT, createdAt);
  }
  return createdAt;
}

export async function getRemoteReadingEvents(): Promise<ReadingEvent[]> {
  const db = await openDb();
  const records = await requestResult(db.transaction(REMOTE_EVENTS).objectStore(REMOTE_EVENTS).getAll()) as RemoteEventRecord[];
  db.close();
  return records.map((record) => record.event);
}

export async function getRemoteReadingEventSourceMonths(): Promise<string[]> {
  const db = await openDb();
  const keys = await requestResult(db.transaction(REMOTE_EVENTS).objectStore(REMOTE_EVENTS).index("sourceMonth").getAllKeys());
  db.close();
  return [...new Set(keys.map(String))];
}

export async function replaceRemoteReadingEventMonth(clientId: string, clientName: string, month: string, events: ReadingEvent[]) {
  const sourceMonth = `${clientId}:${month}`;
  const db = await openDb();
  const transaction = db.transaction(REMOTE_EVENTS, "readwrite");
  const store = transaction.objectStore(REMOTE_EVENTS);
  const existingKeys = await requestResult(store.index("sourceMonth").getAllKeys(IDBKeyRange.only(sourceMonth)));
  existingKeys.forEach((key) => store.delete(key));
  events.forEach((event) => store.put({
    key: `${sourceMonth}:${event.id}`,
    sourceMonth,
    clientId,
    month,
    event: { ...event, remoteClientId: clientId, remoteClientName: clientName },
  } satisfies RemoteEventRecord));
  await transactionComplete(transaction);
  db.close();
}

export async function removeRemoteReadingEventMonth(sourceMonth: string) {
  const db = await openDb();
  const transaction = db.transaction(REMOTE_EVENTS, "readwrite");
  const cursorRequest = transaction.objectStore(REMOTE_EVENTS).index("sourceMonth").openCursor(IDBKeyRange.only(sourceMonth));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
  cursorRequest.onerror = () => transaction.abort();
  await transactionComplete(transaction);
  db.close();
}

export async function clearRemoteReadingEvents() {
  const db = await openDb();
  const transaction = db.transaction(REMOTE_EVENTS, "readwrite");
  transaction.objectStore(REMOTE_EVENTS).clear();
  await transactionComplete(transaction);
  db.close();
}

export async function getRankingExposures(): Promise<RankingExposure[]> {
  const db = await openDb();
  const exposures = await requestResult(db.transaction(RANKING_EXPOSURES).objectStore(RANKING_EXPOSURES).getAll()) as RankingExposure[];
  db.close();
  return exposures.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function putRankingExposure(exposure: RankingExposure) {
  const db = await openDb();
  const transaction = db.transaction([RANKING_EXPOSURES, SETTINGS], "readwrite");
  const store = transaction.objectStore(RANKING_EXPOSURES);
  const previous = await requestResult(store.get(exposure.id)) as RankingExposure | undefined;
  const localExposure = { ...exposure };
  delete localExposure.remoteClientId;
  delete localExposure.remoteClientName;
  store.put(localExposure);
  const months = [rankingExposureMonth(exposure), ...(previous ? [rankingExposureMonth(previous)] : [])];
  const settingsStore = transaction.objectStore(SETTINGS);
  const current = await requestResult(settingsStore.get(WEBDAV_DIRTY_EXPOSURE_MONTHS)) as string[] | undefined;
  settingsStore.put([...new Set([...(current ?? []), ...months.filter(Boolean)])].sort(), WEBDAV_DIRTY_EXPOSURE_MONTHS);
  await transactionComplete(transaction);
  db.close();
}

export async function getRemoteRankingExposures(): Promise<RankingExposure[]> {
  const db = await openDb();
  const records = await requestResult(db.transaction(REMOTE_RANKING_EXPOSURES).objectStore(REMOTE_RANKING_EXPOSURES).getAll()) as RemoteExposureRecord[];
  db.close();
  return records.map((record) => record.exposure).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getRemoteRankingExposureSourceMonths(): Promise<string[]> {
  const db = await openDb();
  const keys = await requestResult(db.transaction(REMOTE_RANKING_EXPOSURES).objectStore(REMOTE_RANKING_EXPOSURES).index("sourceMonth").getAllKeys());
  db.close();
  return [...new Set(keys.map(String))];
}

export async function replaceRemoteRankingExposureMonth(clientId: string, clientName: string, month: string, exposures: RankingExposure[]) {
  const sourceMonth = `${clientId}:${month}`;
  const db = await openDb();
  const transaction = db.transaction(REMOTE_RANKING_EXPOSURES, "readwrite");
  const store = transaction.objectStore(REMOTE_RANKING_EXPOSURES);
  const existingKeys = await requestResult(store.index("sourceMonth").getAllKeys(IDBKeyRange.only(sourceMonth)));
  existingKeys.forEach((key) => store.delete(key));
  exposures.forEach((exposure) => store.put({
    key: `${sourceMonth}:${exposure.id}`,
    sourceMonth,
    clientId,
    month,
    exposure: { ...exposure, remoteClientId: clientId, remoteClientName: clientName },
  } satisfies RemoteExposureRecord));
  await transactionComplete(transaction);
  db.close();
}

export async function removeRemoteRankingExposureMonth(sourceMonth: string) {
  const db = await openDb();
  const transaction = db.transaction(REMOTE_RANKING_EXPOSURES, "readwrite");
  const store = transaction.objectStore(REMOTE_RANKING_EXPOSURES);
  const keys = await requestResult(store.index("sourceMonth").getAllKeys(IDBKeyRange.only(sourceMonth)));
  keys.forEach((key) => store.delete(key));
  await transactionComplete(transaction);
  db.close();
}

export async function clearRemoteRankingExposures() {
  const db = await openDb();
  const transaction = db.transaction(REMOTE_RANKING_EXPOSURES, "readwrite");
  transaction.objectStore(REMOTE_RANKING_EXPOSURES).clear();
  await transactionComplete(transaction);
  db.close();
}

export async function getProfileSettings(): Promise<ProfileSettings> {
  if (typeof window !== "undefined") {
    try {
      const value = localStorage.getItem(PREFERENCES);
      if (value) return normalizeProfileSettings(JSON.parse(value));
    } catch {
      localStorage.removeItem(PREFERENCES);
    }
  }
  const db = await openDb();
  const value = await requestResult(db.transaction(SETTINGS).objectStore(SETTINGS).get("profile"));
  db.close();
  const settings = normalizeProfileSettings(value);
  await saveProfileSettings(settings);
  return settings;
}

function storedProfileSettings(value: unknown): StoredProfileSettings | undefined {
  return typeof value === "object" && value !== null ? value as StoredProfileSettings : undefined;
}

export function hasLegacyWebDavSettings(value: unknown) {
  const stored = storedProfileSettings(value);
  return stored !== undefined && "webdav" in stored;
}

function normalizeImageLoadingPreferences(value: unknown): ImageLoadingPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const normalized: ImageLoadingPreferences = {};
  for (const [scope, scopedValue] of Object.entries(value)) {
    if (typeof scopedValue !== "object" || scopedValue === null || Array.isArray(scopedValue)) continue;
    const candidate = scopedValue as { defaultMode?: unknown; feedModes?: unknown };
    if (!isImageLoadingMode(candidate.defaultMode)) continue;
    const feedModes: Record<string, ImageLoadingMode> = {};
    if (typeof candidate.feedModes === "object" && candidate.feedModes !== null && !Array.isArray(candidate.feedModes)) {
      for (const [feedId, mode] of Object.entries(candidate.feedModes)) {
        if (/^\d+$/.test(feedId) && isImageLoadingMode(mode)) feedModes[feedId] = mode;
      }
    }
    normalized[scope] = { defaultMode: candidate.defaultMode, feedModes };
  }
  return normalized;
}

function migrateOriginReferrerFeeds(value: unknown): ImageLoadingPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const migrated: ImageLoadingPreferences = {};
  for (const [scope, feedIds] of Object.entries(value)) {
    if (!Array.isArray(feedIds)) continue;
    const feedModes: Record<string, ImageLoadingMode> = {};
    feedIds.forEach((feedId) => {
      if (Number.isSafeInteger(feedId) && feedId >= 0) feedModes[String(feedId)] = "direct-origin";
    });
    migrated[scope] = { defaultMode: "direct-no-referrer", feedModes };
  }
  return migrated;
}

function normalizeMinifluxSyncInterval(value: unknown, fallback: MinifluxSyncInterval): MinifluxSyncInterval {
  return ([0, 30, 60, 120, 240, 480] as unknown[]).includes(value)
    ? value as MinifluxSyncInterval
    : fallback;
}

export function normalizeProfileSettings(value?: unknown): ProfileSettings {
  const stored = storedProfileSettings(value);
  const language = stored?.language;
  const imageLoadingPreferences = stored?.imageLoadingPreferences === undefined
    ? migrateOriginReferrerFeeds(stored?.originReferrerFeeds)
    : normalizeImageLoadingPreferences(stored.imageLoadingPreferences);
  return {
    theme: stored?.theme === "night" ? "night" : "day",
    ...(isSupportedLanguage(language) ? { language } : {}),
    showFeedArticleCount: stored?.showFeedArticleCount === true,
    markReadOnScroll: stored?.markReadOnScroll !== false,
    imageLoadingPreferences,
    incrementalSyncIntervalMinutes: normalizeMinifluxSyncInterval(
      stored?.incrementalSyncIntervalMinutes,
      DEFAULT_INCREMENTAL_SYNC_INTERVAL,
    ),
    fullSyncIntervalMinutes: normalizeMinifluxSyncInterval(
      stored?.fullSyncIntervalMinutes,
      DEFAULT_FULL_SYNC_INTERVAL,
    ),
    updatedAt: stored?.updatedAt ?? new Date(0).toISOString(),
  };
}

export async function saveProfileSettings(settings: ProfileSettings) {
  localStorage.setItem(PREFERENCES, JSON.stringify(settings));
}

export function newReadingEvent(input: Omit<ReadingEvent, "id" | "openedAt" | "updatedAt" | "activeSeconds" | "scrollDepth" | "readingTime" | "listPosition"> & { readingTime?: number; listPosition?: number }): ReadingEvent {
  const now = new Date().toISOString();
  return {
    ...input,
    id: crypto.randomUUID(),
    openedAt: now,
    updatedAt: now,
    activeSeconds: 0,
    scrollDepth: 0,
  };
}
