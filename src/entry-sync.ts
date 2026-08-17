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
  return cached.title !== entry.title
    || cached.url !== entry.url
    || cached.content !== entry.content
    || cached.author !== entry.author;
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
