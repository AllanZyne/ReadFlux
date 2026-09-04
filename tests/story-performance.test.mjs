import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  nextStoryRenderCount,
  STORY_RENDER_BATCH_SIZE,
  storyIdsPassedByScroll,
} from "../src/story-list.ts";
import { storyTextForEntry } from "../src/story-text.ts";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

test("large article lists render in bounded progressive batches", () => {
  assert.equal(STORY_RENDER_BATCH_SIZE, 60);
  assert.equal(nextStoryRenderCount(0, 30), 30);
  assert.equal(nextStoryRenderCount(60, 824), 120);
  assert.equal(nextStoryRenderCount(820, 824), 824);
  assert.match(app, /const renderedStories = useMemo\([\s\S]*?visible\.slice\(0, renderedStoryCount\)/);
  assert.match(app, /onScroll=\{handleStoryListScroll\}/);
  assert.match(app, /ref=\{storyListRef\}/);
  assert.match(app, /resetRenderedStories[\s\S]*?previousStoryListScrollTop\.current = 0;[\s\S]*?storyListRef\.current\.scrollTop = 0/);
  assert.match(app, /renderedStories\.map\(\(story\)/);
  assert.match(app, /const StoryRow = memo\(function StoryRow/);
  assert.match(app, /selected=\{selected\?\.id === story\.id\}/);
  assert.match(app, /count: Math\.min\(STORY_RENDER_BATCH_SIZE, visible\.length - renderedStories\.length\)/);
  assert.doesNotMatch(app, /visible\.map\(\(story\) => <article/);
});

test("scroll-to-read selects only stories that fully passed the list boundary", () => {
  assert.deepEqual(storyIdsPassedByScroll([
    { id: 1, offsetTop: 0, offsetHeight: 80 },
    { id: 2, offsetTop: 80, offsetHeight: 100 },
    { id: 3, offsetTop: 180, offsetHeight: 100 },
  ], 180), [1, 2]);
  assert.deepEqual(storyIdsPassedByScroll([
    { id: 1, offsetTop: 0, offsetHeight: 80 },
  ], 79), []);
  assert.match(app, /const candidateIdSet = new Set\(candidateIds\);/);
  assert.match(app, /const unreadIds = entriesRef\.current\.flatMap/);
  assert.doesNotMatch(app, /candidateIds\.filter\([\s\S]{0,180}entriesRef\.current\.find/);
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

test("article selection paints before deferred reader work and list mutations", () => {
  assert.match(app, /const deferredSelectedId = useDeferredValue\(selectedId\)/);
  assert.match(app, /const readerSelected = deferredSelectedId === selectedId \? selected : null/);
  assert.match(app, /readerSelected\?\.id !== selected\.id[\s\S]*?reader\.loadingContent/);
  assert.match(app, /startTransition\(\(\) => \{\s*replaceEntries\(\(current\)/);
  assert.match(app, /replaceEntries\(\(current\)[\s\S]*?setEntryLabels/);
  assert.match(app, /startTransition\(\(\) => \{\s*void updateEntry\(story\.id, \{ status: "read" \}/);
});

test("frozen list order does not require an effect-driven second render", () => {
  assert.doesNotMatch(app, /\[visibleIds, setVisibleIds\]/);
  assert.doesNotMatch(app, /setVisibleIds\(/);
  assert.match(app, /const frozenVisibleOrder = useMemo\([\s\S]*?ids: filtered\.map\(\(story\) => story\.id\)/);
  assert.match(app, /capturedVisibleOrder\.current === frozenVisibleOrder\.ids/);

  const captureStart = app.indexOf("if (capturedVisibleOrder.current === frozenVisibleOrder.ids)");
  const captureEnd = app.indexOf("}, [visible, frozenVisibleOrder", captureStart);
  const captureEffect = app.slice(captureStart, captureEnd);
  assert.ok(captureStart >= 0 && captureEnd > captureStart);
  assert.doesNotMatch(captureEffect, /setVisible|setListOrderVersion/);
});

test("background sync preserves the frozen list and sync reset restores the first batch", () => {
  assert.match(app, /const initialCacheHydration = hydratedConnectionRef\.current !== config;[\s\S]*?if \(initialCacheHydration \|\| snapshotMissesCache\) \{\s*setListOrderVersion/);
  assert.match(app, /if \(snapshotMissesCache\) \{\s*setListReadSnapshot/);
  assert.doesNotMatch(app, /replaceEntries\(cached\);\s*setListOrderVersion/);
  assert.match(app, /onResetSync=\{async \(\) => \{\s*syncResetInProgress\.current = true;\s*resetRenderedStories\(\);/);
});
