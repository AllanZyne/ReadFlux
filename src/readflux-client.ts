import type { OriginReferrerFeeds } from "./article-images";
import { isSupportedLanguage, type SupportedLanguage } from "./languages.ts";

export type ConnectionConfig = {
  url: string;
  apiKey: string;
  remember: boolean;
};

export type ThemeName = "day" | "night";

export type ProfileSettings = {
  theme: ThemeName;
  language?: SupportedLanguage;
  entryLookbackDays?: number | null;
  originReferrerFeeds?: OriginReferrerFeeds;
  updatedAt: string;
};

type StoredProfileSettings = Partial<ProfileSettings> & { webdav?: unknown };

export type EntrySyncPhase = "unread" | "starred" | "read";

export type EntrySyncState = {
  initialSyncComplete: boolean;
  lookbackDays: number | null;
  phase?: EntrySyncPhase;
  offset?: number;
  updatedAt?: string;
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
  updatedAt: string;
};

const LOCAL_CONFIG = "readflux.miniflux.local";
const SESSION_CONFIG = "readflux.miniflux.session";
const DB_NAME = "readflux-profile";
const DB_VERSION = 3;
const EVENTS = "reading-events";
const SETTINGS = "settings";
const ENTRY_CACHE = "entry-cache";
const ENTRY_LABELS = "entry-labels";

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
  const transaction = db.transaction([ENTRY_CACHE, ENTRY_LABELS, SETTINGS], "readwrite");
  for (const storeName of [ENTRY_CACHE, ENTRY_LABELS]) {
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

export function normalizeReadingEventOpenedAt(value: string): string | null {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

export async function putReadingEvent(event: ReadingEvent) {
  const db = await openDb();
  const tx = db.transaction(EVENTS, "readwrite");
  tx.objectStore(EVENTS).put(event);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function deleteReadingEvent(id: string) {
  const db = await openDb();
  const tx = db.transaction(EVENTS, "readwrite");
  tx.objectStore(EVENTS).delete(id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getProfileSettings(): Promise<ProfileSettings> {
  const db = await openDb();
  const value = await requestResult(db.transaction(SETTINGS).objectStore(SETTINGS).get("profile"));
  db.close();
  const settings = normalizeProfileSettings(value);
  if (hasLegacyWebDavSettings(value)) await saveProfileSettings(settings);
  return settings;
}

function storedProfileSettings(value: unknown): StoredProfileSettings | undefined {
  return typeof value === "object" && value !== null ? value as StoredProfileSettings : undefined;
}

export function hasLegacyWebDavSettings(value: unknown) {
  const stored = storedProfileSettings(value);
  return stored !== undefined && "webdav" in stored;
}

export function normalizeProfileSettings(value?: unknown): ProfileSettings {
  const stored = storedProfileSettings(value);
  const language = stored?.language;
  return {
    theme: stored?.theme === "night" ? "night" : "day",
    ...(isSupportedLanguage(language) ? { language } : {}),
    entryLookbackDays: stored?.entryLookbackDays === undefined ? 30 : stored.entryLookbackDays,
    originReferrerFeeds: stored?.originReferrerFeeds ?? {},
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

export function newReadingEvent(input: Omit<ReadingEvent, "id" | "openedAt" | "updatedAt" | "activeSeconds" | "scrollDepth">): ReadingEvent {
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
