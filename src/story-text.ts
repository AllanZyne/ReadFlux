export type StoryTextSource = {
  title: string;
  content: string;
};

export type StoryText = {
  recommendationText: string;
  summary: string;
};

const STORY_TEXT_CACHE_LIMIT = 5_000;
const storyTextCache = new Map<string, Map<string, StoryText>>();
let storyTextCacheEntries = 0;

const toText = (html: string) => html
  .replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&#39;/g, "'")
  .replace(/&quot;/g, "\"")
  .replace(/\s+/g, " ")
  .trim();

export function storyTextForEntry(entry: StoryTextSource) {
  const cachedByTitle = storyTextCache.get(entry.content);
  const cached = cachedByTitle?.get(entry.title);
  if (cached) return cached;

  const text = toText(entry.content);
  const result = {
    recommendationText: `${entry.title} ${text.slice(0, 240)}`,
    summary: text.slice(0, 160),
  };
  if (cachedByTitle) cachedByTitle.set(entry.title, result);
  else storyTextCache.set(entry.content, new Map([[entry.title, result]]));
  storyTextCacheEntries += 1;
  if (storyTextCacheEntries > STORY_TEXT_CACHE_LIMIT) {
    const oldestKey = storyTextCache.keys().next().value;
    if (oldestKey !== undefined) {
      storyTextCacheEntries -= storyTextCache.get(oldestKey)?.size ?? 0;
      storyTextCache.delete(oldestKey);
    }
  }
  return result;
}
