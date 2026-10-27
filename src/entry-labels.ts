/**
 * Local labels on Miniflux entries, kept only in this browser. `updated` marks
 * a read article whose content changed after it was cached and clears once
 * the article is reopened or marked read. `later` is the user's Read later
 * tag and clears only when the user removes it. Each label records when it
 * was added.
 */
export type EntryLabel = "updated" | "later";

export type EntryLabelTimes = Readonly<Partial<Record<EntryLabel, string>>>;

export type EntryLabels = ReadonlyMap<number, EntryLabelTimes>;

/** An entry and the time its label was added, or null to remove the label. */
export type EntryLabelChange = readonly [entryId: number, addedAt: string | null];

export function hasEntryLabel(labels: EntryLabels | undefined, entryId: number, label: EntryLabel) {
  return labels?.get(entryId)?.[label] !== undefined;
}

/** Applies the changes to one label; when nothing changes, the same map is returned. */
export function withEntryLabel(labels: EntryLabels, label: EntryLabel, changes: Iterable<EntryLabelChange>): EntryLabels {
  let next: Map<number, EntryLabelTimes> | null = null;
  for (const [entryId, addedAt] of changes) {
    const current = (next ?? labels).get(entryId);
    if ((current?.[label] ?? null) === addedAt) continue;
    next ??= new Map(labels);
    const times: Partial<Record<EntryLabel, string>> = { ...current };
    if (addedAt === null) delete times[label];
    else times[label] = addedAt;
    if (Object.keys(times).length) next.set(entryId, times);
    else next.delete(entryId);
  }
  return next ?? labels;
}

/** The changes that put each entry's label back to its time in `labels`. */
export function entryLabelRestore(labels: EntryLabels, label: EntryLabel, entryIds: Iterable<number>): EntryLabelChange[] {
  return [...entryIds].map((entryId) => [entryId, labels.get(entryId)?.[label] ?? null]);
}

export function sameEntryLabels(current: EntryLabels, next: EntryLabels) {
  if (current === next) return true;
  if (current.size !== next.size) return false;
  for (const [entryId, times] of current) {
    const other = next.get(entryId);
    if (!other) return false;
    const labels = Object.keys(times) as EntryLabel[];
    if (labels.length !== Object.keys(other).length) return false;
    if (!labels.every((label) => other[label] === times[label])) return false;
  }
  return true;
}
