import {
  claimDirtyRankingExposureMonths,
  claimDirtyReadingEventMonths,
  getReadingEvents,
  getRankingExposures,
  getRemoteRankingExposures,
  getRemoteRankingExposureSourceMonths,
  getRemoteReadingEvents,
  getRemoteReadingEventSourceMonths,
  getWebDavClientCreatedAt,
  getWebDavClientId,
  markRankingExposureMonthsDirty,
  markReadingEventMonthsDirty,
  rankingExposureMonth,
  readingEventMonth,
  removeRemoteRankingExposureMonth,
  removeRemoteReadingEventMonth,
  replaceRemoteRankingExposureMonth,
  replaceRemoteReadingEventMonth,
  type ReadingEvent,
  type RankingExposure,
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

type ExposureMonthFile = {
  schemaVersion: 1;
  clientId: string;
  clientName: string;
  month: string;
  updatedAt: string;
  exposures: RankingExposure[];
};

export type WebDavSyncResult = {
  events: ReadingEvent[];
  exposures: RankingExposure[];
  uploadedMonths: number;
  uploadedExposureMonths: number;
  downloadedMonths: number;
  downloadedExposureMonths: number;
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

export function webDavConnectionIdentity(config: Pick<WebDavConfig, "url" | "username">) {
  return `${config.url.replace(/\/+$/, "")}/\n${config.username}`;
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
  for (const path of ["v1/", "v1/clients/", `v1/clients/${clientId}/`, `v1/clients/${clientId}/events/`, `v1/clients/${clientId}/exposures/`]) {
    await ensureCollection(config, path);
  }
}

function cleanExposure(exposure: RankingExposure): RankingExposure {
  const cleaned = { ...exposure };
  delete cleaned.remoteClientId;
  delete cleaned.remoteClientName;
  return cleaned;
}

function cleanEvent(event: ReadingEvent): ReadingEvent {
  const cleaned = { ...event };
  delete cleaned.remoteClientId;
  delete cleaned.remoteClientName;
  return cleaned;
}

function readEtagCache(config: WebDavConfig) {
  try {
    const cached = JSON.parse(localStorage.getItem(ETAG_CACHE) ?? "null") as { identity?: string; values?: Record<string, string> } | null;
    return cached?.identity === webDavConnectionIdentity(config) ? cached.values ?? {} : {};
  } catch {
    return {};
  }
}

function writeEtagCache(config: WebDavConfig, values: Record<string, string>) {
  localStorage.setItem(ETAG_CACHE, JSON.stringify({ identity: webDavConnectionIdentity(config), values }));
}

export function clearWebDavEtagCache() {
  localStorage.removeItem(ETAG_CACHE);
}

async function uploadLocalMonths(config: WebDavConfig, clientId: string) {
  const dirtyMonths = await claimDirtyReadingEventMonths();
  if (!dirtyMonths.length) return 0;
  let uploaded = 0;
  try {
    const events = await getReadingEvents();
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
      uploaded += 1;
    }
  } catch (cause) {
    await markReadingEventMonthsDirty(dirtyMonths.slice(uploaded));
    throw cause;
  }
  return uploaded;
}

async function uploadLocalExposureMonths(config: WebDavConfig, clientId: string) {
  const dirtyMonths = await claimDirtyRankingExposureMonths();
  if (!dirtyMonths.length) return 0;
  let uploaded = 0;
  try {
    const exposures = await getRankingExposures();
    for (const month of dirtyMonths) {
      const payload: ExposureMonthFile = {
        schemaVersion: SCHEMA_VERSION,
        clientId,
        clientName: config.clientName,
        month,
        updatedAt: new Date().toISOString(),
        exposures: exposures.filter((exposure) => rankingExposureMonth(exposure) === month).map(cleanExposure),
      };
      await request(config, `v1/clients/${clientId}/exposures/${month}.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      uploaded += 1;
    }
  } catch (cause) {
    await markRankingExposureMonthsDirty(dirtyMonths.slice(uploaded));
    throw cause;
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
    && typeof event.updatedAt === "string"
    && (event.rankingId === undefined || typeof event.rankingId === "string")
    && (event.exposedRank === undefined || Number.isSafeInteger(event.exposedRank))
    && (event.algorithmVersion === undefined || typeof event.algorithmVersion === "string")
    && (event.starred === undefined || typeof event.starred === "boolean")
    && (event.starredAt === undefined || typeof event.starredAt === "string");
}

function validRankingExposure(value: unknown): value is RankingExposure {
  if (!value || typeof value !== "object") return false;
  const exposure = value as Partial<RankingExposure>;
  return typeof exposure.id === "string"
    && typeof exposure.createdAt === "string"
    && typeof exposure.algorithmVersion === "string"
    && [1, 2].includes(exposure.schemaVersion ?? 0)
    && exposure.surface === "today"
    && Number.isSafeInteger(exposure.candidateCount)
    && Number.isSafeInteger(exposure.displayedCount)
    && Array.isArray(exposure.items)
    && exposure.items.every((item) => Number.isFinite(item.entryId)
      && Number.isSafeInteger(item.rank)
      && Number.isFinite(item.score)
      && Number.isFinite(item.sourceScore)
      && Number.isFinite(item.termScore)
      && Number.isFinite(item.freshnessScore)
      && Number.isFinite(item.savedBonus)
      && Number.isFinite(item.negativePenalty)
      && Number.isFinite(item.statusPriority)
      && Array.isArray(item.matchedTerms)
      && item.matchedTerms.every((term) => typeof term === "string"))
    && (exposure.bulkDismissedAt === undefined || typeof exposure.bulkDismissedAt === "string")
    && (exposure.bulkDismissedEntryIds === undefined || (Array.isArray(exposure.bulkDismissedEntryIds)
      && exposure.bulkDismissedEntryIds.every(Number.isFinite)));
}

function validExposureMonthFile(value: unknown): value is ExposureMonthFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<ExposureMonthFile>;
  return file.schemaVersion === 1
    && typeof file.clientId === "string"
    && /^\d{4}-\d{2}$/.test(file.month ?? "")
    && Array.isArray(file.exposures)
    && file.exposures.every(validRankingExposure);
}

async function optionalPropfind(config: WebDavConfig, path: string) {
  try {
    return await propfind(config, path);
  } catch (cause) {
    if (cause instanceof WebDavError && cause.status === 404) return [];
    throw cause;
  }
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
      const etagKey = `events:${sourceMonth}`;
      if (cachedSources.has(sourceMonth) && entry.etag && cachedEtags[etagKey] === entry.etag) continue;
      const response = await request(config, `v1/clients/${encodeURIComponent(client.name)}/events/${entry.name}`);
      const payload = await response.json() as unknown;
      if (!validMonthFile(payload) || payload.clientId !== client.name || payload.month !== month) continue;
      await replaceRemoteReadingEventMonth(client.name, payload.clientName || client.name, month, payload.events.map(cleanEvent));
      nextEtags[etagKey] = entry.etag;
      downloaded += 1;
    }
  }

  for (const sourceMonth of cachedSources) {
    if (remoteSourceMonths.has(sourceMonth)) continue;
    await removeRemoteReadingEventMonth(sourceMonth);
    delete nextEtags[`events:${sourceMonth}`];
  }
  writeEtagCache(config, nextEtags);
  return { downloaded, clientCount: clients.length };
}

async function downloadRemoteExposureMonths(config: WebDavConfig, ownClientId: string) {
  const clients = (await propfind(config, "v1/clients/"))
    .filter((entry) => entry.collection && entry.name && entry.name !== ownClientId);
  const cachedEtags = readEtagCache(config);
  const nextEtags = { ...cachedEtags };
  const cachedSources = new Set(await getRemoteRankingExposureSourceMonths());
  const remoteSourceMonths = new Set<string>();
  let downloaded = 0;

  for (const client of clients) {
    const entries = (await optionalPropfind(config, `v1/clients/${encodeURIComponent(client.name)}/exposures/`))
      .filter((entry) => !entry.collection && /^\d{4}-\d{2}\.json$/.test(entry.name));
    for (const entry of entries) {
      const month = entry.name.slice(0, 7);
      const sourceMonth = `${client.name}:${month}`;
      const etagKey = `exposures:${sourceMonth}`;
      remoteSourceMonths.add(sourceMonth);
      if (cachedSources.has(sourceMonth) && entry.etag && cachedEtags[etagKey] === entry.etag) continue;
      const response = await request(config, `v1/clients/${encodeURIComponent(client.name)}/exposures/${entry.name}`);
      const payload = await response.json() as unknown;
      if (!validExposureMonthFile(payload) || payload.clientId !== client.name || payload.month !== month) continue;
      await replaceRemoteRankingExposureMonth(client.name, payload.clientName || client.name, month, payload.exposures.map(cleanExposure));
      nextEtags[etagKey] = entry.etag;
      downloaded += 1;
    }
  }

  for (const sourceMonth of cachedSources) {
    if (remoteSourceMonths.has(sourceMonth)) continue;
    await removeRemoteRankingExposureMonth(sourceMonth);
    delete nextEtags[`exposures:${sourceMonth}`];
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
      const uploadedExposureMonths = await uploadLocalExposureMonths(config, clientId);
      const remoteEvents = options.pull === false
        ? { downloaded: 0, clientCount: 0 }
        : await downloadRemoteMonths(config, clientId);
      const remoteExposures = options.pull === false
        ? { downloaded: 0, clientCount: 0 }
        : await downloadRemoteExposureMonths(config, clientId);
      return {
        events: await getRemoteReadingEvents(),
        exposures: await getRemoteRankingExposures(),
        uploadedMonths,
        uploadedExposureMonths,
        downloadedMonths: remoteEvents.downloaded,
        downloadedExposureMonths: remoteExposures.downloaded,
        clientCount: Math.max(remoteEvents.clientCount, remoteExposures.clientCount) + 1,
        syncedAt: new Date().toISOString(),
      };
    });
  });
}
