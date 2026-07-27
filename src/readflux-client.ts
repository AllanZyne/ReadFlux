export type ConnectionConfig = {
  url: string;
  apiKey: string;
  remember: boolean;
};

export type WebDavConfig = {
  url: string;
  username: string;
  password: string;
  passphrase: string;
};

export type ThemeName = "day" | "night";

export type ProfileSettings = {
  theme: ThemeName;
  webdav?: WebDavConfig;
  updatedAt: string;
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
const DB_VERSION = 1;
const EVENTS = "reading-events";
const SETTINGS = "settings";

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
    throw new Error(`Miniflux 请求失败（${response.status}）`);
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
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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
  return (value as ProfileSettings | undefined) ?? {
    theme: "day",
    updatedAt: new Date(0).toISOString(),
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

type SyncPayload = {
  version: 1;
  events: ReadingEvent[];
  settings: Omit<ProfileSettings, "webdav">;
};

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function deriveKey(passphrase: string, salt: Uint8Array) {
  const saltBuffer = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer;
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBuffer, iterations: 180_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encrypt(payload: SyncPayload, passphrase: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  return JSON.stringify({
    v: 1,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(cipher),
  });
}

async function decrypt(value: string, passphrase: string): Promise<SyncPayload> {
  const envelope = JSON.parse(value) as { v: number; salt: string; iv: string; data: string };
  if (envelope.v !== 1) throw new Error("不支持的同步文件版本");
  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const key = await deriveKey(passphrase, salt);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    base64ToBytes(envelope.data),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as SyncPayload;
}

function webDavHeaders(config: WebDavConfig) {
  return {
    Authorization: `Basic ${btoa(`${config.username}:${config.password}`)}`,
    "Content-Type": "application/octet-stream",
  };
}

function syncUrl(config: WebDavConfig) {
  const base = config.url.replace(/\/+$/, "");
  return base.endsWith(".enc") ? base : `${base}/readflux-profile.v1.enc`;
}

export async function syncWithWebDav(
  config: WebDavConfig,
  localEvents: ReadingEvent[],
  settings: ProfileSettings,
) {
  let remote: SyncPayload | null = null;
  const response = await fetch(syncUrl(config), { headers: webDavHeaders(config) });
  if (response.ok) remote = await decrypt(await response.text(), config.passphrase);
  else if (response.status !== 404) throw new Error(`WebDAV 读取失败（${response.status}）`);

  const merged = new Map<string, ReadingEvent>();
  [...(remote?.events ?? []), ...localEvents].forEach((event) => {
    const current = merged.get(event.id);
    if (!current || current.updatedAt < event.updatedAt) merged.set(event.id, event);
  });
  const remoteSettings = remote?.settings;
  const profile = remoteSettings && remoteSettings.updatedAt > settings.updatedAt
    ? { ...settings, theme: remoteSettings.theme, updatedAt: remoteSettings.updatedAt }
    : settings;
  const payload: SyncPayload = {
    version: 1,
    events: [...merged.values()],
    settings: { theme: profile.theme, updatedAt: profile.updatedAt },
  };
  const upload = await fetch(syncUrl(config), {
    method: "PUT",
    headers: webDavHeaders(config),
    body: await encrypt(payload, config.passphrase),
  });
  if (!upload.ok) throw new Error(`WebDAV 写入失败（${upload.status}）`);

  for (const event of payload.events) await putReadingEvent(event);
  await saveProfileSettings({ ...profile, webdav: config });
  return { events: payload.events, settings: { ...profile, webdav: config } };
}
