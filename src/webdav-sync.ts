import {
  clearDirtyReadingEventMonth,
  getDirtyReadingEventMonths,
  getReadingEvents,
  getRemoteReadingEvents,
  getRemoteReadingEventSourceMonths,
  getWebDavClientCreatedAt,
  getWebDavClientId,
  readingEventMonth,
  removeRemoteReadingEventMonth,
  replaceRemoteReadingEventMonth,
  type ReadingEvent,
  type WebDavConfig,
} from "./readflux-client.ts";

const SCHEMA_VERSION = 1;
const ETAG_CACHE = "readflux.webdav.etags";

type WebDavEntry = {
  href: string;
  name: string;
  etag: string;
  collection: boolean;
};

type EventMonthFile = {
  schemaVersion: 1;
  clientId: string;
  clientName: string;
  month: string;
  updatedAt: string;
  events: ReadingEvent[];
};

export type WebDavSyncResult = {
  events: ReadingEvent[];
  uploadedMonths: number;
  downloadedMonths: number;
  clientCount: number;
  syncedAt: string;
};

export class WebDavError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "WebDavError";
    this.status = status;
  }
}

function baseURL(config: WebDavConfig) {
  return `${config.url.replace(/\/+$/, "")}/`;
}

function childURL(config: WebDavConfig, path: string) {
  return new URL(path.replace(/^\/+/, ""), baseURL(config)).toString();
}

function basicAuthorization(config: WebDavConfig) {
  const bytes = new TextEncoder().encode(`${config.username}:${config.password}`);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return `Basic ${btoa(binary)}`;
}

async function request(config: WebDavConfig, path: string, init: RequestInit = {}) {
  const response = await fetch(childURL(config, path), {
    ...init,
    headers: {
      Authorization: basicAuthorization(config),
      ...init.headers,
    },
  });
  if (!response.ok) throw new WebDavError(`WebDAV request failed (${response.status})`, response.status);
  return response;
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizedWebDavPath(value: string) {
  try {
    return decodeURIComponent(new URL(value, "https://readflux.invalid").pathname).replace(/\/+$/, "");
  } catch {
    return decodeURIComponent(value).replace(/\/+$/, "");
  }
}

export function parseWebDavPropfind(xml: string, requestedCollection?: string): WebDavEntry[] {
  const requestedPath = requestedCollection ? normalizedWebDavPath(requestedCollection) : undefined;
  const responses = xml.match(/<(?:[\w-]+:)?response\b[\s\S]*?<\/(?:[\w-]+:)?response>/gi) ?? [];
  return responses.flatMap((block) => {
    const hrefMatch = block.match(/<(?:[\w-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/i);
    if (!hrefMatch) return [];
    const href = decodeXml(hrefMatch[1].trim());
    const pathname = normalizedWebDavPath(href);
    if (requestedPath && pathname === requestedPath) return [];
    const etagMatch = block.match(/<(?:[\w-]+:)?getetag\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?getetag>/i);
    return [{
      href,
      name: pathname.slice(pathname.lastIndexOf("/") + 1),
      etag: etagMatch ? decodeXml(etagMatch[1].trim()) : "",
      collection: /<(?:[\w-]+:)?collection\b/i.test(block),
    }];
  });
}

async function propfind(config: WebDavConfig, path: string) {
  const response = await request(config, path, {
    method: "PROPFIND",
    headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
    body: "<?xml version=\"1.0\"?><propfind xmlns=\"DAV:\"><prop><resourcetype/><getetag/></prop></propfind>",
  });
  return parseWebDavPropfind(await response.text(), childURL(config, path));
}

async function ensureCollection(config: WebDavConfig, path: string) {
  const response = await fetch(childURL(config, path), {
    method: "MKCOL",
    headers: { Authorization: basicAuthorization(config) },
  });
  if (![201, 405].includes(response.status)) {
    throw new WebDavError(`Could not create WebDAV collection (${response.status})`, response.status);
  }
}

async function ensureClientCollections(config: WebDavConfig, clientId: string) {
  for (const path of ["v1/", "v1/clients/", `v1/clients/${clientId}/`, `v1/clients/${clientId}/events/`]) {
    await ensureCollection(config, path);
  }
}

function cleanEvent(event: ReadingEvent): ReadingEvent {
  const cleaned = { ...event };
  delete cleaned.remoteClientId;
  delete cleaned.remoteClientName;
  return cleaned;
}

function readEtagCache(config: WebDavConfig) {
  try {
    const cached = JSON.parse(localStorage.getItem(ETAG_CACHE) ?? "null") as { url?: string; values?: Record<string, string> } | null;
    return cached?.url === baseURL(config) ? cached.values ?? {} : {};
  } catch {
    return {};
  }
}

function writeEtagCache(config: WebDavConfig, values: Record<string, string>) {
  localStorage.setItem(ETAG_CACHE, JSON.stringify({ url: baseURL(config), values }));
}

export function clearWebDavEtagCache() {
  localStorage.removeItem(ETAG_CACHE);
}

async function uploadLocalMonths(config: WebDavConfig, clientId: string) {
  const dirtyMonths = await getDirtyReadingEventMonths();
  if (!dirtyMonths.length) return 0;
  const events = await getReadingEvents();
  let uploaded = 0;
  for (const month of dirtyMonths) {
    const payload: EventMonthFile = {
      schemaVersion: SCHEMA_VERSION,
      clientId,
      clientName: config.clientName,
      month,
      updatedAt: new Date().toISOString(),
      events: events.filter((event) => readingEventMonth(event) === month).map(cleanEvent),
    };
    await request(config, `v1/clients/${clientId}/events/${month}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await clearDirtyReadingEventMonth(month);
    uploaded += 1;
  }
  return uploaded;
}

function validMonthFile(value: unknown): value is EventMonthFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<EventMonthFile>;
  return file.schemaVersion === 1
    && typeof file.clientId === "string"
    && /^\d{4}-\d{2}$/.test(file.month ?? "")
    && Array.isArray(file.events)
    && file.events.every(validReadingEvent);
}

function validReadingEvent(value: unknown): value is ReadingEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<ReadingEvent>;
  return typeof event.id === "string"
    && Number.isFinite(event.entryId)
    && Number.isFinite(event.feedId)
    && typeof event.title === "string"
    && typeof event.source === "string"
    && Array.isArray(event.terms)
    && event.terms.every((term) => typeof term === "string")
    && typeof event.openedAt === "string"
    && Number.isFinite(event.activeSeconds)
    && Number.isFinite(event.scrollDepth)
    && ["recommendation", "feed", "search", "saved"].includes(event.origin ?? "")
    && typeof event.updatedAt === "string";
}

async function downloadRemoteMonths(config: WebDavConfig, ownClientId: string) {
  const clients = (await propfind(config, "v1/clients/"))
    .filter((entry) => entry.collection && entry.name && entry.name !== ownClientId);
  const cachedEtags = readEtagCache(config);
  const nextEtags = { ...cachedEtags };
  const cachedSources = new Set(await getRemoteReadingEventSourceMonths());
  const remoteSourceMonths = new Set<string>();
  let downloaded = 0;

  for (const client of clients) {
    const entries = (await propfind(config, `v1/clients/${encodeURIComponent(client.name)}/events/`))
      .filter((entry) => !entry.collection && /^\d{4}-\d{2}\.json$/.test(entry.name));
    for (const entry of entries) {
      const month = entry.name.slice(0, 7);
      const sourceMonth = `${client.name}:${month}`;
      remoteSourceMonths.add(sourceMonth);
      if (cachedSources.has(sourceMonth) && entry.etag && cachedEtags[sourceMonth] === entry.etag) continue;
      const response = await request(config, `v1/clients/${encodeURIComponent(client.name)}/events/${entry.name}`);
      const payload = await response.json() as unknown;
      if (!validMonthFile(payload) || payload.clientId !== client.name || payload.month !== month) continue;
      await replaceRemoteReadingEventMonth(client.name, payload.clientName || client.name, month, payload.events.map(cleanEvent));
      nextEtags[sourceMonth] = entry.etag;
      downloaded += 1;
    }
  }

  for (const sourceMonth of cachedSources) {
    if (remoteSourceMonths.has(sourceMonth)) continue;
    await removeRemoteReadingEventMonth(sourceMonth);
    delete nextEtags[sourceMonth];
  }
  writeEtagCache(config, nextEtags);
  return { downloaded, clientCount: clients.length };
}

let syncQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const result = syncQueue.then(work, work);
  syncQueue = result.catch(() => undefined);
  return result;
}

function withBrowserLock<T>(clientId: string, work: () => Promise<T>) {
  if (navigator.locks) return navigator.locks.request(`readflux-webdav-${clientId}`, work);
  return work();
}

export async function testWebDavConnection(config: WebDavConfig) {
  return serialize(async () => {
    const clientId = getWebDavClientId();
    return withBrowserLock(clientId, async () => {
      await ensureClientCollections(config, clientId);
      await propfind(config, "v1/clients/");
    });
  });
}

export function synchronizeWebDav(config: WebDavConfig, options: { pull?: boolean } = {}): Promise<WebDavSyncResult> {
  return serialize(async () => {
    const clientId = getWebDavClientId();
    return withBrowserLock(clientId, async () => {
      await ensureClientCollections(config, clientId);
      await request(config, `v1/clients/${clientId}/client.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          clientId,
          name: config.clientName,
          createdAt: getWebDavClientCreatedAt(),
          lastSeenAt: new Date().toISOString(),
        }),
      });
      const uploadedMonths = await uploadLocalMonths(config, clientId);
      const remote = options.pull === false
        ? { downloaded: 0, clientCount: 0 }
        : await downloadRemoteMonths(config, clientId);
      return {
        events: await getRemoteReadingEvents(),
        uploadedMonths,
        downloadedMonths: remote.downloaded,
        clientCount: remote.clientCount + 1,
        syncedAt: new Date().toISOString(),
      };
    });
  });
}
