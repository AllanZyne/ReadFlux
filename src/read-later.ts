/**
 * Read later saves links from articles as entries of one disabled Miniflux
 * feed. The feed points at a static, empty Atom file shipped with ReadFlux,
 * which Miniflux fetches once when the feed is created; every device finds
 * the same feed by that file name, so no local identifier needs syncing.
 */

export const READ_LATER_FEED_FILE = "readflux-read-later.xml";
export const READ_LATER_CATEGORY_TITLE = "ReadFlux · Read later";
/** The first Miniflux release with the entry import endpoint. */
export const READ_LATER_MINIFLUX_VERSION = "2.2.16";

const MAX_TITLE_LENGTH = 200;

/** Link text that names the action rather than the page it opens. */
const GENERIC_LINK_TEXT = new Set([
  "here", "link", "this", "this link", "click here", "read more", "more", "continue reading",
  "source", "original", "article", "permalink", "full article", "full story", "via",
  "原文", "链接", "原文链接", "阅读原文", "阅读全文", "查看原文", "点击这里", "点击", "这里", "详情", "更多", "来源",
  "ici", "lien", "cet article", "en savoir plus", "lire la suite", "lire plus", "source originale",
]);

export type MinifluxJsonFetch = <T>(path: string, init?: RequestInit) => Promise<T>;

export type ReadLaterLink = { url: string; title: string; tags?: string[] };

/**
 * The feed a link was saved from travels as a Miniflux tag, the only field an
 * import can set besides the page's own data, so every device can show it.
 */
const SOURCE_TAG_PREFIX = "via ";

export const readLaterSourceTag = (source: string) => `${SOURCE_TAG_PREFIX}${source.trim()}`;

export function readLaterSourceFromTags(tags?: readonly string[] | null) {
  const tag = tags?.find((value) => value.startsWith(SOURCE_TAG_PREFIX));
  return tag?.slice(SOURCE_TAG_PREFIX.length).trim() || undefined;
}

type MinifluxFeed = { id: number; feed_url?: string };
type MinifluxCategory = { id: number; title: string };

export class ReadLaterError extends Error {
  readonly kind: "unsupported" | "feed-unavailable";
  readonly version?: string;
  readonly feedURL?: string;

  constructor(kind: ReadLaterError["kind"], details: { version?: string; feedURL?: string; cause?: unknown } = {}) {
    super(kind === "unsupported" ? "Miniflux cannot import entries" : "Miniflux cannot fetch the Read later feed", { cause: details.cause });
    this.name = "ReadLaterError";
    this.kind = kind;
    this.version = details.version;
    this.feedURL = details.feedURL;
  }
}

/** The feed file next to the ReadFlux page, wherever it is deployed. */
export function readLaterFeedFileURL(pageURL: string) {
  return new URL(READ_LATER_FEED_FILE, pageURL).href;
}

export function isReadLaterFeedURL(feedURL?: string) {
  if (!feedURL) return false;
  try {
    return new URL(feedURL).pathname.endsWith(`/${READ_LATER_FEED_FILE}`);
  } catch {
    return false;
  }
}

export function readLaterFeedIds(feeds: readonly MinifluxFeed[]) {
  return new Set(feeds.filter((feed) => isReadLaterFeedURL(feed.feed_url)).map((feed) => feed.id));
}

/**
 * The absolute http(s) URL a link opens, or null for in-page anchors and
 * other schemes. Relative links resolve against the article's own URL, not
 * ReadFlux's page. The fragment stays: it can name a section or a route.
 */
export function articleLinkHref(href: string | null | undefined, baseURL?: string) {
  const value = href?.trim();
  if (!value || value.startsWith("#")) return null;
  let url: URL;
  try {
    url = new URL(value, baseURL || undefined);
  } catch {
    try {
      url = new URL(value);
    } catch {
      return null;
    }
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}

/** The link's URL without its fragment, for matching it to synced entries. */
export function readLaterLinkURL(href: string | null | undefined, baseURL?: string) {
  const resolved = articleLinkHref(href, baseURL);
  if (!resolved) return null;
  const url = new URL(resolved);
  url.hash = "";
  return url.href;
}

function cleanLinkText(value?: string | null) {
  const text = (value ?? "").replace(/\s+/gu, " ").trim();
  return [...text].length > MAX_TITLE_LENGTH
    ? `${[...text].slice(0, MAX_TITLE_LENGTH - 1).join("").trimEnd()}…`
    : text;
}

function looksLikeURL(text: string) {
  return /^(https?:\/\/|www\.)/i.test(text) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/u.test(text);
}

function describesPage(text: string) {
  if ([...text].length < 2 || looksLikeURL(text)) return false;
  const key = text.toLowerCase().replace(/^[\s«‹<「【[(]+|[\s.。…!！:：»›>→」】\])]+$/gu, "");
  return !!key && !GENERIC_LINK_TEXT.has(key);
}

/** Host and the last path segment, for links whose text does not name the page. */
export function fallbackReadLaterTitle(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const segment = parsed.pathname.split("/").filter(Boolean).pop();
    if (!segment) return host;
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch { /* keep the encoded segment */ }
    const words = decoded.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[-_+]+/g, " ").trim();
    return words ? `${host} · ${words}` : host;
  } catch {
    return url;
  }
}

/**
 * The browser cannot read another site's title, so the link itself supplies
 * one: its text, then its title attribute, then the alt text of a linked image.
 */
export function readLaterLinkTitle(
  link: { text?: string | null; title?: string | null; imageAlt?: string | null },
  url: string,
) {
  for (const candidate of [link.text, link.title, link.imageAlt]) {
    const text = cleanLinkText(candidate);
    if (describesPage(text)) return text;
  }
  return fallbackReadLaterTitle(url);
}

/** Unknown or development version strings pass; the import request then decides. */
export function minifluxVersionAtLeast(version: string | undefined, minimum: string) {
  const parts = (value: string) => (value.match(/\d+/g) ?? []).slice(0, 3).map(Number);
  if (!version || !/\d/.test(version)) return true;
  const current = parts(version);
  const required = parts(minimum);
  for (let index = 0; index < 3; index += 1) {
    const difference = (current[index] ?? 0) - (required[index] ?? 0);
    if (difference) return difference > 0;
  }
  return true;
}

function requestFailure(cause: unknown) {
  return cause && typeof cause === "object"
    ? cause as { status?: number; detail?: string }
    : {};
}

const isTombstoned = (cause: unknown) => {
  const failure = requestFailure(cause);
  return failure.status === 400 && /tombstoned/i.test(failure.detail ?? "");
};

const isMissingFeed = (cause: unknown) => {
  const failure = requestFailure(cause);
  return failure.status === 400 && /feed does not exist/i.test(failure.detail ?? "");
};

const postJson = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

async function readLaterCategoryId(fetchJson: MinifluxJsonFetch) {
  const find = async () => (await fetchJson<MinifluxCategory[]>("/v1/categories") ?? [])
    .find((category) => category.title === READ_LATER_CATEGORY_TITLE);
  const existing = await find();
  if (existing) return existing.id;
  try {
    return (await fetchJson<MinifluxCategory>("/v1/categories", postJson({ title: READ_LATER_CATEGORY_TITLE }))).id;
  } catch (cause) {
    // Another device may have created it a moment ago.
    const created = await find().catch(() => undefined);
    if (created) return created.id;
    throw cause;
  }
}

/** Finds the Read later feed in Miniflux, creating its category and feed when missing. */
export async function ensureReadLaterFeed(fetchJson: MinifluxJsonFetch, feedURL: string) {
  const { version } = await fetchJson<{ version?: string }>("/v1/version").catch(() => ({ version: undefined }));
  if (!minifluxVersionAtLeast(version, READ_LATER_MINIFLUX_VERSION)) throw new ReadLaterError("unsupported", { version });
  const find = async () => (await fetchJson<MinifluxFeed[]>("/v1/feeds") ?? [])
    .find((feed) => isReadLaterFeedURL(feed.feed_url));
  const existing = await find();
  if (existing) return { feedId: existing.id, created: false };
  const categoryId = await readLaterCategoryId(fetchJson);
  try {
    // Disabled, so Miniflux never polls the empty file again.
    const created = await fetchJson<{ feed_id: number }>("/v1/feeds", postJson({ feed_url: feedURL, category_id: categoryId, disabled: true }));
    return { feedId: created.feed_id, created: true };
  } catch (cause) {
    const raced = await find().catch(() => undefined);
    if (raced) return { feedId: raced.id, created: true };
    throw new ReadLaterError("feed-unavailable", { feedURL, cause });
  }
}

/**
 * Imports the link as an unread entry; importing an existing link returns its
 * entry and marks it unread again. Miniflux keeps a tombstone for entries its
 * cleanup deleted, so a link read and cleaned up earlier imports under a new
 * external ID instead.
 */
export async function importReadLaterEntry(fetchJson: MinifluxJsonFetch, feedId: number, link: ReadLaterLink, now = Date.now()) {
  const path = `/v1/feeds/${feedId}/entries/import`;
  const entry = { url: link.url, title: link.title, status: "unread", ...(link.tags?.length ? { tags: link.tags } : {}) };
  try {
    return (await fetchJson<{ id: number }>(path, postJson(entry))).id;
  } catch (cause) {
    if (!isTombstoned(cause)) throw cause;
    return (await fetchJson<{ id: number }>(path, postJson({ ...entry, external_id: `readflux:${now}:${link.url}` }))).id;
  }
}

/**
 * Saves a link to Read later and asks Miniflux to fetch its content.
 * `feedResolved` reports that the feed was looked up in Miniflux, so the
 * caller's feed catalog may be missing it.
 */
export async function saveReadLaterLink(
  fetchJson: MinifluxJsonFetch,
  options: { feedId?: number; feedURL: string; link: ReadLaterLink },
) {
  let feedId = options.feedId;
  let feedResolved = false;
  if (feedId === undefined) {
    feedId = (await ensureReadLaterFeed(fetchJson, options.feedURL)).feedId;
    feedResolved = true;
  }
  let entryId: number;
  try {
    entryId = await importReadLaterEntry(fetchJson, feedId, options.link);
  } catch (cause) {
    // A feed deleted in Miniflux since the catalog was cached is found or recreated once.
    if (feedResolved || !isMissingFeed(cause)) throw cause;
    feedId = (await ensureReadLaterFeed(fetchJson, options.feedURL)).feedId;
    feedResolved = true;
    entryId = await importReadLaterEntry(fetchJson, feedId, options.link);
  }
  // Miniflux scrapes the page server-side; without it the entry still opens the link.
  await fetchJson(`/v1/entries/${entryId}/fetch-content?update_content=true`).catch(() => undefined);
  return { entryId, feedId, feedResolved };
}
