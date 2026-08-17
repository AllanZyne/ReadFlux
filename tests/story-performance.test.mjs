import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { nextStoryRenderCount, STORY_RENDER_BATCH_SIZE } from "../src/story-list.ts";
import { storyTextForEntry } from "../src/story-text.ts";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

test("large article lists render in bounded progressive batches", () => {
  assert.equal(STORY_RENDER_BATCH_SIZE, 60);
  assert.equal(nextStoryRenderCount(0, 30), 30);
  assert.equal(nextStoryRenderCount(60, 824), 120);
  assert.equal(nextStoryRenderCount(820, 824), 824);
  assert.match(app, /const renderedStories = useMemo\([\s\S]*?visible\.slice\(0, renderedStoryCount\)/);
  assert.match(app, /onScroll=\{loadMoreStoriesNearEnd\}/);
  assert.match(app, /renderedStories\.map\(\(story\)/);
  assert.doesNotMatch(app, /visible\.map\(\(story\) => <article/);
});

test("article text extraction is reused until title or content changes", () => {
  const entry = { title: "A title", content: "<p>Hello &amp; goodbye</p>" };
  const first = storyTextForEntry(entry);
  const cached = storyTextForEntry({ ...entry });
  const changedContent = storyTextForEntry({ ...entry, content: "<p>Different</p>" });
  const changedTitle = storyTextForEntry({ ...entry, title: "Another title" });

  assert.strictEqual(cached, first);
  assert.notStrictEqual(changedContent, first);
  assert.notStrictEqual(changedTitle, first);
  assert.equal(first.summary, "Hello & goodbye");
  assert.equal(first.recommendationText, "A title Hello & goodbye");
});

test("story metadata and recommendation scoring have separate memoized stages", () => {
  assert.match(app, /const baseStories = useMemo<BaseStory\[\]>/);
  assert.match(app, /const stories = useMemo<Story\[\]>/);
  assert.match(app, /text: story\.recommendationText/);
});
