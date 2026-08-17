export const STORY_RENDER_BATCH_SIZE = 60;

export function nextStoryRenderCount(current: number, total: number) {
  return Math.min(total, Math.max(STORY_RENDER_BATCH_SIZE, current + STORY_RENDER_BATCH_SIZE));
}
