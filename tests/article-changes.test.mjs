import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { diffBlocks, diffText, textParts, titleChanges } from "../src/article-changes.ts";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

/** Each edit as the current text it marks and the previous text it carries. */
const marked = (previous, current) => diffText(previous, current).map((edit) => [current.slice(edit.start, edit.end), edit.previous]);

test("replaced words carry the text they replaced, numbers included", () => {
  assert.deepEqual(marked(
    "The operator said around 120 trains had been cancelled, affecting an estimated 40,000 passengers.",
    "The operator said around 310 trains had been cancelled, affecting an estimated 95,000 passengers.",
  ), [["310", "120"], ["95,000", "40,000"]]);
  // A space between two changed words joins them into one mark.
  assert.deepEqual(marked("halts commuter lines today", "called off deal today"), [["called off deal", "halts commuter lines"]]);
});

test("insertions carry no previous text and removals mark the point they left", () => {
  assert.deepEqual(marked(
    "Officials said the strike would end with an improved offer.",
    "Officials had said the strike would end with an improved offer, which it did on Tuesday.",
  ), [["had", ""], [", which it did on Tuesday", ""]]);

  const previous = "Northwind said it was disappointed by the action and that its offer remained on the table.";
  const current = "Northwind said it was disappointed by the action.";
  const [removal] = diffText(previous, current);
  assert.equal(removal.start, removal.end);
  assert.equal(current.slice(0, removal.start), "Northwind said it was disappointed by the action");
  assert.equal(removal.previous, "and that its offer remained on the table");
});

test("white space alone is not a change", () => {
  assert.deepEqual(diffText("one  two\nthree", "one two three"), []);
  assert.deepEqual(diffText("same", "same"), []);
});

test("Chinese text is compared by word, not by line", () => {
  assert.deepEqual(
    marked("今天的天气很好，我们去公园散步。", "今天的天气不好，我们在家看书。"),
    [["不好", "很好"], ["在家看书", "去公园散步"]],
  );
});

test("blocks are aligned into added, changed, and removed paragraphs", () => {
  const previous = ["The first paragraph stays the same.", "Second paragraph with alpha beta gamma delta.", "A paragraph that is removed entirely.", "The last paragraph stays."];
  const current = ["An update added at the top.", "The first paragraph stays the same.", "Second paragraph with alpha beta gamma epsilon.", "The last paragraph stays."];
  const changes = diffBlocks(previous, current);
  assert.deepEqual(changes.map((change) => change.kind), ["added", "changed", "removed"]);
  assert.equal(changes[0].index, 0);
  assert.equal(changes[1].index, 2);
  assert.deepEqual(changes[1].edits.map((edit) => current[2].slice(edit.start, edit.end)), ["epsilon"]);
  // The removed paragraph shows before the block that now follows it.
  assert.deepEqual(changes[2], { kind: "removed", before: 3, previous: ["A paragraph that is removed entirely."] });
});

test("consecutive removed paragraphs share one marker", () => {
  const changes = diffBlocks(["Kept opening paragraph here.", "Gone one entirely different.", "Gone two also unrelated.", "Kept closing paragraph here."], ["Kept opening paragraph here.", "Kept closing paragraph here."]);
  assert.deepEqual(changes, [{ kind: "removed", before: 1, previous: ["Gone one entirely different.", "Gone two also unrelated."] }]);
});

test("without Intl.Segmenter, text is still compared by word", async () => {
  const { Segmenter } = Intl;
  delete Intl.Segmenter;
  try {
    const fallback = await import("../src/article-changes.ts?without-segmenter");
    const edits = (previous, current) => fallback.diffText(previous, current).map((edit) => [current.slice(edit.start, edit.end), edit.previous]);
    assert.deepEqual(edits("around 120 trains, 40,000 people", "around 310 trains, 95,000 people"), [["310", "120"], ["95,000", "40,000"]]);
    assert.deepEqual(edits("天气很好", "天气不好"), [["不", "很"]]);
  } finally {
    Intl.Segmenter = Segmenter;
  }
});

test("pairing blocks stops at its work limit and treats the article as rewritten", () => {
  const previous = Array.from({ length: 300 }, (_, index) => `Old paragraph ${index} about apples and pears.`);
  const current = Array.from({ length: 300 }, (_, index) => `New section ${index} covering rivers, hills, and roads.`);
  assert.equal(diffBlocks(previous, current), null);
});

test("a block of numbers alone is compared", () => {
  const changes = diffBlocks(["Passengers affected by the strike today.", "40,000"], ["Passengers affected by the strike today.", "95,000"]);
  assert.deepEqual(changes, [{ kind: "changed", index: 1, edits: [{ start: 0, end: 6, previous: "40,000" }] }]);
});

test("a rewritten article shows no marks", () => {
  assert.equal(diffBlocks(["The original summary only."], ["A completely different full article body arrives instead of the summary."]), null);
  assert.equal(diffBlocks(["Something was here."], []), null);
  assert.deepEqual(diffBlocks(["Unchanged."], ["Unchanged."]), []);
});

test("titles split into unchanged text and marked parts", () => {
  assert.deepEqual(titleChanges("Strike halts commuter lines", "Strike called off after deal"), [
    { text: "Strike " },
    { text: "called off after deal", change: "replaced", previous: "halts commuter lines" },
  ]);
  assert.equal(titleChanges("Same title", "Same  title"), null);
  assert.deepEqual(textParts("ab", [{ start: 1, end: 1, previous: "x" }]), [
    { text: "a" },
    { text: "", change: "removed", previous: "x" },
    { text: "b" },
  ]);
});

test("the reader shows changes only for the reading that clears the updated label", () => {
  assert.match(app, /setChangeBase\(null\);\s*const changeRequest = \+\+changeBaseRequest\.current;\s*if \(config && hasEntryLabel\(entryLabels, story\.id, "updated"\)\) \{\s*void getEntryRevision\(story\.id\)/);
  // A revision that loads after another article opened is dropped.
  assert.match(app, /if \(revision && changeBaseRequest\.current === changeRequest\) setChangeBase\(revision\)/);
  // A translation is rebuilt from the original nodes and shows no marks, in the title either.
  assert.match(app, /const bodyChanges = translatedContent \? null : articleChanges;/);
  assert.match(app, /const shownTitleChanges = translatedContent \? null : titleChangeParts;/);
  // The keyboard reaches marks, and the card describes the focused one.
  assert.match(app, /root\.addEventListener\("focusin", focusIn\)/);
  assert.match(app, /mark\.setAttribute\("aria-describedby", CHANGE_TIP_ID\)/);
  // Both versions go through the sanitizer before they are compared.
  assert.match(app, /markArticleChanges\(\s*safeHtml\(readerContent, minifluxURL, selectedImageMode\),\s*safeHtml\(readerChangeBase\.content, minifluxURL, selectedImageMode\),?\s*\)/);
  assert.match(app, /await labelUpdatedEntries\(detectedAt, readVersions\)/);
});
