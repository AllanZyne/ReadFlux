import {
  isImageLoadingMode,
  type ImageLoadingMode,
  type ImageLoadingPreferences,
} from "./article-images.ts";
import { isSupportedLanguage, type SupportedLanguage } from "./languages.ts";
import type { TermRuleOperation } from "./recommendation-terms.ts";

export type ConnectionConfig = {
  url: string;
  apiKey: string;
  remember: boolean;
};

export type ThemeName = "day" | "night";

export type ProfileSettings = {
  theme: ThemeName;
  language?: SupportedLanguage;
  imageLoadingPreferences: ImageLoadingPreferences;
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
  updatedAt?: string;
};

export type CachedFeedIcon = {
  feedId: number;
  iconId: number;
  src: string;
};

export type ReadingEvent = {
  id: string;
  entryId: number;
  feedId: number;
  title: string;
  source: string;
  terms: string[];
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
const SESSION_CONFIG = "readflux.miniflux.session";
const DB_NAME = "readflux-profile";
const DB_VERSION = 8;
const EVENTS = "reading-events";
const SETTINGS = "settings";
const ENTRY_CACHE = "entry-cache";
const ENTRY_LABELS = "entry-labels";
const FEED_ICONS = "feed-icons";
const REMOTE_EVENTS = "remote-reading-events";
const RANKING_EXPOSURES = "ranking-exposures";
const REMOTE_RANKING_EXPOSURES = "remote-ranking-exposures";
const TERM_RULE_OPERATIONS = "term-rule-operations";
const WEBDAV_CONFIG = "readflux.webdav";
const WEBDAV_CLIENT_ID = "readflux.webdav.client-id";
const WEBDAV_CLIENT_CREATED_AT = "readflux.webdav.client-created-at";
const WEBDAV_DIRTY_MONTHS = "webdav-dirty-months";
const WEBDAV_DIRTY_EXPOSURE_MONTHS = "webdav-dirty-exposure-months";
const WEBDAV_TERM_RULES_DIRTY = "webdav-term-rules-dirty";

type CacheableEntry = {
  id: number;
};

type EntryCacheRecord<T extends CacheableEntry = CacheableEntry> = {
  key: string;
  scope: string;
  entry: T;
};

type EntryLabelRecord = {
  key: string;
  scope: string;
  entryId: number;
  labels: string[];
};

type FeedIconRecord = CachedFeedIcon & {
  key: string;
  scope: string;
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
  for (const storage of [sessionStorage, localStorage]) {
    const value = storage.getItem(storage === sessionStorage ? SESSION_CONFIG : LOCAL_CONFIG);
    if (!value) continue;
    try {
      return JSON.parse(value) as ConnectionConfig;
    } catch {
      storage.removeItem(storage === sessionStorage ? SESSION_CONFIG : LOCAL_CONFIG);
    }
  }
  return null;
}

export function saveConnection(config: ConnectionConfig) {
  const target = config.remember ? localStorage : sessionStorage;
  const other = config.remember ? sessionStorage : localStorage;
  target.setItem(config.remember ? LOCAL_CONFIG : SESSION_CONFIG, JSON.stringify(config));
  other.removeItem(config.remember ? SESSION_CONFIG : LOCAL_CONFIG);
}

export function clearConnection() {
  localStorage.removeItem(LOCAL_CONFIG);
  sessionStorage.removeItem(SESSION_CONFIG);
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
      if (!db.objectStoreNames.contains(ENTRY_CACHE)) {
        const store = db.createObjectStore(ENTRY_CACHE, { keyPath: "key" });
        store.createIndex("scope", "scope");
      }
      if (!db.objectStoreNames.contains(ENTRY_LABELS)) {
        const store = db.createObjectStore(ENTRY_LABELS, { keyPath: "key" });
        store.createIndex("scope", "scope");
      }
      if (!db.objectStoreNames.contains(FEED_ICONS)) {
        const store = db.createObjectStore(FEED_ICONS, { keyPath: "key" });
        store.createIndex("scope", "scope");
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
      if (!db.objectStoreNames.contains(TERM_RULE_OPERATIONS)) {
        const store = db.createObjectStore(TERM_RULE_OPERATIONS, { keyPath: "id" });
        store.createIndex("clientId", "clientId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function entryCacheScope(config: ConnectionConfig) {
  const value = new TextEncoder().encode(`${config.url.replace(/\/+$/, "")}\n${config.apiKey}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return bytesToBase64(digest);
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function getCachedEntries<T extends CacheableEntry>(config: ConnectionConfig): Promise<T[]> {
  const [db, scope] = await Promise.all([openDb(), entryCacheScope(config)]);
  const records = await requestResult(
    db.transaction(ENTRY_CACHE).objectStore(ENTRY_CACHE).index("scope").getAll(scope),
  ) as EntryCacheRecord<T>[];
  db.close();
  return records.map((record) => record.entry);
}

export async function putCachedEntries<T extends CacheableEntry>(config: ConnectionConfig, entries: T[]) {
  if (!entries.length) return;
  const [db, scope] = await Promise.all([openDb(), entryCacheScope(config)]);
  const transaction = db.transaction(ENTRY_CACHE, "readwrite");
  const store = transaction.objectStore(ENTRY_CACHE);
  entries.forEach((entry) => {
    const record: EntryCacheRecord<T> = { key: `${scope}:${entry.id}`, scope, entry };
    store.put(record);
  });
  await transactionComplete(transaction);
  db.close();
}

export async function getCachedFeedIcons(config: ConnectionConfig): Promise<CachedFeedIcon[]> {
  const [db, scope] = await Promise.all([openDb(), entryCacheScope(config)]);
  const records = await requestResult(
    db.transaction(FEED_ICONS).objectStore(FEED_ICONS).index("scope").getAll(scope),
  ) as FeedIconRecord[];
  db.close();
  return records.map(({ feedId, iconId, src }) => ({ feedId, iconId, src }));
}

export async function putCachedFeedIcons(config: ConnectionConfig, icons: CachedFeedIcon[]) {
  if (!icons.length) return;
  const [db, scope] = await Promise.all([openDb(), entryCacheScope(config)]);
  const transaction = db.transaction(FEED_ICONS, "readwrite");
  const store = transaction.objectStore(FEED_ICONS);
  icons.forEach((icon) => {
    const record: FeedIconRecord = {
      key: `${scope}:${icon.feedId}`,
      scope,
      ...icon,
    };
    store.put(record);
  });
  await transactionComplete(transaction);
  db.close();
}

export async function getEntrySyncState(config: ConnectionConfig): Promise<EntrySyncState | null> {
  const [db, scope] = await Promise.all([openDb(), entryCacheScope(config)]);
  const value = await requestResult(
    db.transaction(SETTINGS).objectStore(SETTINGS).get(`entry-sync-state:${scope}`),
  );
  db.close();
  return value && typeof value === "object" ? value as EntrySyncState : null;
}

export async function saveEntrySyncState(config: ConnectionConfig, state: EntrySyncState) {
  const [db, scope] = await Promise.all([openDb(), entryCacheScope(config)]);
  const transaction = db.transaction(SETTINGS, "readwrite");
  transaction.objectStore(SETTINGS).put(state, `entry-sync-state:${scope}`);
  await transactionComplete(transaction);
  db.close();
}

export async function resetEntrySync(config: ConnectionConfig) {
  const [db, scope] = await Promise.all([openDb(), entryCacheScope(config)]);
  const transaction = db.transaction([ENTRY_CACHE, ENTRY_LABELS, FEED_ICONS, SETTINGS], "readwrite");
  for (const storeName of [ENTRY_CACHE, ENTRY_LABELS, FEED_ICONS]) {
    const cursorRequest = transaction.objectStore(storeName)
      .index("scope")
      .openCursor(IDBKeyRange.only(scope));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    cursorRequest.onerror = () => transaction.abort();
  }
  transaction.objectStore(SETTINGS).delete(`entry-sync-state:${scope}`);
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

export async function getTermRuleOperations(): Promise<TermRuleOperation[]> {
  const db = await openDb();
  const operations = await requestResult(db.transaction(TERM_RULE_OPERATIONS).objectStore(TERM_RULE_OPERATIONS).getAll()) as TermRuleOperation[];
  db.close();
  return operations;
}

export async function putTermRuleOperation(operation: TermRuleOperation) {
  const db = await openDb();
  const transaction = db.transaction([TERM_RULE_OPERATIONS, SETTINGS], "readwrite");
  transaction.objectStore(TERM_RULE_OPERATIONS).put(operation);
  transaction.objectStore(SETTINGS).put(true, WEBDAV_TERM_RULES_DIRTY);
  await transactionComplete(transaction);
  db.close();
}

export async function claimDirtyTermRules() {
  const db = await openDb();
  const transaction = db.transaction(SETTINGS, "readwrite");
  const store = transaction.objectStore(SETTINGS);
  const dirty = await requestResult(store.get(WEBDAV_TERM_RULES_DIRTY)) === true;
  store.put(false, WEBDAV_TERM_RULES_DIRTY);
  await transactionComplete(transaction);
  db.close();
  return dirty;
}

export async function markTermRulesDirty() {
  const db = await openDb();
  const transaction = db.transaction(SETTINGS, "readwrite");
  transaction.objectStore(SETTINGS).put(true, WEBDAV_TERM_RULES_DIRTY);
  await transactionComplete(transaction);
  db.close();
}

export async function replaceRemoteTermRuleOperations(clientId: string, operations: TermRuleOperation[]) {
  const db = await openDb();
  const transaction = db.transaction(TERM_RULE_OPERATIONS, "readwrite");
  const store = transaction.objectStore(TERM_RULE_OPERATIONS);
  const keys = await requestResult(store.index("clientId").getAllKeys(IDBKeyRange.only(clientId)));
  keys.forEach((key) => store.delete(key));
  operations.forEach((operation) => store.put(operation));
  await transactionComplete(transaction);
  db.close();
}

export async function clearRemoteTermRuleOperations(ownClientId: string) {
  const db = await openDb();
  const transaction = db.transaction(TERM_RULE_OPERATIONS, "readwrite");
  const store = transaction.objectStore(TERM_RULE_OPERATIONS);
  const operations = await requestResult(store.getAll()) as TermRuleOperation[];
  operations.filter((operation) => operation.clientId !== ownClientId).forEach((operation) => store.delete(operation.id));
  await transactionComplete(transaction);
  db.close();
}

export async function getProfileSettings(): Promise<ProfileSettings> {
  const db = await openDb();
  const value = await requestResult(db.transaction(SETTINGS).objectStore(SETTINGS).get("profile"));
  db.close();
  const settings = normalizeProfileSettings(value);
  if (hasLegacyWebDavSettings(value) || hasLegacyImageSettings(value)) await saveProfileSettings(settings);
  return settings;
}

function storedProfileSettings(value: unknown): StoredProfileSettings | undefined {
  return typeof value === "object" && value !== null ? value as StoredProfileSettings : undefined;
}

export function hasLegacyWebDavSettings(value: unknown) {
  const stored = storedProfileSettings(value);
  return stored !== undefined && "webdav" in stored;
}

function hasLegacyImageSettings(value: unknown) {
  const stored = storedProfileSettings(value);
  return stored !== undefined && "originReferrerFeeds" in stored;
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

export function normalizeProfileSettings(value?: unknown): ProfileSettings {
  const stored = storedProfileSettings(value);
  const language = stored?.language;
  const imageLoadingPreferences = stored?.imageLoadingPreferences === undefined
    ? migrateOriginReferrerFeeds(stored?.originReferrerFeeds)
    : normalizeImageLoadingPreferences(stored.imageLoadingPreferences);
  return {
    theme: stored?.theme === "night" ? "night" : "day",
    ...(isSupportedLanguage(language) ? { language } : {}),
    imageLoadingPreferences,
    updatedAt: stored?.updatedAt ?? new Date(0).toISOString(),
  };
}

export async function saveProfileSettings(settings: ProfileSettings) {
  const db = await openDb();
  const tx = db.transaction(SETTINGS, "readwrite");
  tx.objectStore(SETTINGS).put(settings, "profile");
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
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

export async function getEntryLabels(config: ConnectionConfig): Promise<Map<number, string[]>> {
  const [db, scope] = await Promise.all([openDb(), entryCacheScope(config)]);
  const records = await requestResult(
    db.transaction(ENTRY_LABELS).objectStore(ENTRY_LABELS).index("scope").getAll(scope),
  ) as EntryLabelRecord[];
  db.close();
  return new Map(records.filter((r) => r.labels.length).map((r) => [r.entryId, r.labels]));
}

export async function addEntryLabel(config: ConnectionConfig, entryId: number, label: string) {
  const [db, scope] = await Promise.all([openDb(), entryCacheScope(config)]);
  const key = `${scope}:${entryId}`;
  const transaction = db.transaction(ENTRY_LABELS, "readwrite");
  const store = transaction.objectStore(ENTRY_LABELS);
  const existing = await requestResult(store.get(key)) as EntryLabelRecord | undefined;
  const labels = existing?.labels ?? [];
  if (!labels.includes(label)) {
    store.put({ key, scope, entryId, labels: [...labels, label] });
  }
  await transactionComplete(transaction);
  db.close();
}

export async function removeEntryLabel(config: ConnectionConfig, entryId: number, label: string) {
  const [db, scope] = await Promise.all([openDb(), entryCacheScope(config)]);
  const key = `${scope}:${entryId}`;
  const transaction = db.transaction(ENTRY_LABELS, "readwrite");
  const store = transaction.objectStore(ENTRY_LABELS);
  const existing = await requestResult(store.get(key)) as EntryLabelRecord | undefined;
  if (existing) {
    const labels = existing.labels.filter((l) => l !== label);
    if (labels.length) store.put({ key, scope, entryId, labels });
    else store.delete(key);
  }
  await transactionComplete(transaction);
  db.close();
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}
