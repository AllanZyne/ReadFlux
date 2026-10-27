import assert from "node:assert/strict";
import test from "node:test";
import { entryLabelRestore, hasEntryLabel, sameEntryLabels, withEntryLabel } from "../src/entry-labels.ts";

const EARLIER = "2026-10-26T08:00:00.000Z";
const LATER = "2026-10-27T08:00:00.000Z";

test("labels are added, retimed, and removed per label", () => {
  const empty = new Map();
  const tagged = withEntryLabel(empty, "later", [[1, EARLIER], [2, EARLIER]]);
  assert.deepEqual(tagged, new Map([[1, { later: EARLIER }], [2, { later: EARLIER }]]));
  assert.equal(empty.size, 0);

  const both = withEntryLabel(tagged, "updated", [[1, LATER]]);
  assert.deepEqual(both.get(1), { later: EARLIER, updated: LATER });
  assert.equal(hasEntryLabel(both, 1, "updated"), true);
  assert.equal(hasEntryLabel(both, 2, "updated"), false);
  assert.equal(hasEntryLabel(undefined, 1, "later"), false);

  // Removing the last label drops the entry; another label survives.
  const cleared = withEntryLabel(both, "later", [[1, null], [2, null]]);
  assert.deepEqual(cleared, new Map([[1, { updated: LATER }]]));
});

test("unchanged labels keep the map's identity", () => {
  const labels = new Map([[1, { later: EARLIER }]]);
  assert.strictEqual(withEntryLabel(labels, "later", [[1, EARLIER], [2, null]]), labels);
  assert.strictEqual(withEntryLabel(labels, "updated", []), labels);
  assert.notStrictEqual(withEntryLabel(labels, "later", [[1, LATER]]), labels);
});

test("a restore puts each label back to its earlier time or removes it", () => {
  const before = new Map([[1, { later: EARLIER }]]);
  const restore = entryLabelRestore(before, "later", [1, 2]);
  assert.deepEqual(restore, [[1, EARLIER], [2, null]]);
  const changed = withEntryLabel(before, "later", [[1, null], [2, LATER]]);
  assert.deepEqual(withEntryLabel(changed, "later", restore), before);
});

test("label maps compare by entries, labels, and times", () => {
  const labels = new Map([[1, { later: EARLIER, updated: LATER }]]);
  assert.equal(sameEntryLabels(labels, new Map([[1, { updated: LATER, later: EARLIER }]])), true);
  assert.equal(sameEntryLabels(labels, new Map([[1, { later: EARLIER }]])), false);
  assert.equal(sameEntryLabels(labels, new Map([[1, { later: LATER, updated: LATER }]])), false);
  assert.equal(sameEntryLabels(labels, new Map([[2, { later: EARLIER, updated: LATER }]])), false);
  assert.equal(sameEntryLabels(new Map(), new Map()), true);
});
