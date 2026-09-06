export const STORY_RENDER_BATCH_SIZE = 60;

/** Keep derived list data until refresh, while projecting live article fields.
 * A new projector starts a fresh snapshot. Newly synced articles are derived
 * once on arrival, so direct article links remain available before refresh.
 */
export function createStoryProjector<E extends { id: number; updated?: boolean }, S extends E>(derive: (entry: E) => S) {
  const snapshots = new Map<number, S>();
  const projected = new WeakMap<E, S>();
  return (entries: E[]): S[] => entries.map((entry) => {
    const cached = projected.get(entry);
    if (cached) return cached;
    const snapshot = snapshots.get(entry.id);
    const story = snapshot ? { ...snapshot, ...entry, updated: entry.updated } : derive(entry);
    if (!snapshot) snapshots.set(entry.id, story);
    projected.set(entry, story);
    return story;
  });
}

export function nextStoryRenderCount(current: number, total: number) {
  return Math.min(total, Math.max(STORY_RENDER_BATCH_SIZE, current + STORY_RENDER_BATCH_SIZE));
}

export function storyIdsPassedByScroll(
  stories: { id: number; offsetTop: number; offsetHeight: number }[],
  scrollTop: number,
) {
  return stories
    .filter((story) => story.offsetTop + story.offsetHeight <= scrollTop)
    .map((story) => story.id);
}
