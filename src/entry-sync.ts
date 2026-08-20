type SyncEntry = {
  id: number;
  status: "read" | "unread" | "removed";
  title?: string;
  url?: string;
  content: string;
  author?: string;
  changed_at?: string;
};

const CURSOR_OVERLAP_MS = 5_000;

const BLOCK_TAG_PATTERN = /<\/?(?:address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi;
const HIDDEN_CONTENT_PATTERN = /<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const HTML_TAG_PATTERN = /<[^>]*>/g;
const MEDIA_CONTAINER_PATTERN = /<(video|audio|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const MEDIA_OPEN_TAG_PATTERN = /<(video|audio|iframe)\b[^>]*>/gi;
const IMAGE_TAG_PATTERN = /<img\b[^>]*>/gi;
const ALT_ATTRIBUTE_PATTERN = /\salt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function decodeCommonHtmlEntities(value: string) {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (entity, decimal, hexadecimal, named) => {
    if (decimal) {
      const codePoint = Number(decimal);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10FFFF
        ? String.fromCodePoint(codePoint)
        : entity;
    }
    if (hexadecimal) {
      const codePoint = Number.parseInt(hexadecimal, 16);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10FFFF
        ? String.fromCodePoint(codePoint)
        : entity;
    }
    return HTML_ENTITIES[named.toLowerCase()] ?? entity;
  });
}

export function normalizeArticleText(value?: string) {
  return decodeCommonHtmlEntities(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeArticleContent(content: string) {
  const semanticMarkup = content
    .replace(HTML_COMMENT_PATTERN, "")
    .replace(HIDDEN_CONTENT_PATTERN, "")
    .replace(MEDIA_CONTAINER_PATTERN, (_tag, rawName: string) => ` [${rawName.toLowerCase()}] `)
    .replace(MEDIA_OPEN_TAG_PATTERN, (_tag, rawName: string) => ` [${rawName.toLowerCase()}] `)
    .replace(IMAGE_TAG_PATTERN, (tag) => {
      const altMatch = ALT_ATTRIBUTE_PATTERN.exec(tag);
      const alt = normalizeArticleText(altMatch?.[1] ?? altMatch?.[2] ?? altMatch?.[3]);
      return alt ? ` [image:${alt}] ` : " [image] ";
    })
    .replace(BLOCK_TAG_PATTERN, " ")
    .replace(HTML_TAG_PATTERN, "");
  return normalizeArticleText(semanticMarkup);
}

export function newestChangedAt(entries: SyncEntry[], fallback?: string) {
  let newest = fallback && Number.isFinite(Date.parse(fallback)) ? fallback : undefined;
  let newestTime = newest ? Date.parse(newest) : Number.NEGATIVE_INFINITY;
  entries.forEach((entry) => {
    if (!entry.changed_at) return;
    const changedTime = Date.parse(entry.changed_at);
    if (Number.isFinite(changedTime) && changedTime > newestTime) {
      newest = entry.changed_at;
      newestTime = changedTime;
    }
  });
  return newest;
}

export function incrementalChangedAfter(cursor?: string) {
  if (!cursor) return undefined;
  const cursorTime = Date.parse(cursor);
  if (!Number.isFinite(cursorTime)) return undefined;
  return String(Math.max(0, Math.floor((cursorTime - CURSOR_OVERLAP_MS) / 1_000)));
}

export function syncIntervalElapsed(lastSyncAt: string | undefined, intervalMinutes: number, now = Date.now()) {
  if (!intervalMinutes) return false;
  const lastSyncTime = lastSyncAt ? Date.parse(lastSyncAt) : Number.NaN;
  return !Number.isFinite(lastSyncTime) || now - lastSyncTime >= intervalMinutes * 60_000;
}

function articleContentChanged<T extends SyncEntry>(cached: T, entry: T) {
  return normalizeArticleText(cached.title) !== normalizeArticleText(entry.title)
    || normalizeArticleContent(cached.content) !== normalizeArticleContent(entry.content);
}

export function mergeSyncedEntries<T extends SyncEntry>(
  current: T[],
  batch: T[],
): { entries: T[]; mergedBatch: T[]; updatedIds: Set<number> } {
  const merged = new Map(current.map((entry) => [entry.id, entry]));
  const updatedIds = new Set<number>();

  batch.forEach((entry) => {
    const cached = merged.get(entry.id);
    const mergedEntry = {
      ...cached,
      ...entry,
      content: entry.content || cached?.content || "",
    };
    if (cached && cached.status === "read" && articleContentChanged(cached, mergedEntry)) {
      updatedIds.add(entry.id);
    }
    merged.set(entry.id, mergedEntry);
  });

  return {
    entries: [...merged.values()],
    mergedBatch: batch.map((entry) => merged.get(entry.id) ?? entry),
    updatedIds,
  };
}
