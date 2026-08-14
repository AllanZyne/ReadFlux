type SyncEntry = {
  id: number;
  status: "read" | "unread" | "removed";
  content: string;
  changed_at?: string;
};

export function mergeSyncedEntries<T extends SyncEntry>(
  current: T[],
  batch: T[],
): { entries: T[]; mergedBatch: T[]; updatedIds: Set<number> } {
  const merged = new Map(current.map((entry) => [entry.id, entry]));
  const updatedIds = new Set<number>();

  batch.forEach((entry) => {
    const cached = merged.get(entry.id);
    if (cached && cached.status === "read" && entry.changed_at && cached.changed_at
      && entry.changed_at > cached.changed_at) {
      updatedIds.add(entry.id);
    }
    merged.set(entry.id, {
      ...cached,
      ...entry,
      content: entry.content || cached?.content || "",
    });
  });

  return {
    entries: [...merged.values()],
    mergedBatch: batch.map((entry) => merged.get(entry.id) ?? entry),
    updatedIds,
  };
}
