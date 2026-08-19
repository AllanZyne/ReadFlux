export const STORY_RENDER_BATCH_SIZE = 60;

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
