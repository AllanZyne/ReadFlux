type SyncEntry = {
  id: number;
  status: "read" | "unread" | "removed";
  title?: string;
  url?: string;
  content: string;
  author?: string;
  changed_at?: string;
};

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
