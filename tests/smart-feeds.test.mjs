import assert from "node:assert/strict";
import test from "node:test";
import {
  compareSmartFeedEntries,
  isEntryInSmartFeed,
  localDayKey,
} from "../src/smart-feeds.mjs";

const TODAY = "2026-7-2";

const entry = (overrides = {}) => ({
  status: "unread",
  starred: false,
  published_at: "2026-08-02T04:00:00.000Z",
  score: 0,
  ...overrides,
});

test("localDayKey uses the browser-local calendar date", () => {
  const value = new Date(2026, 7, 2, 23, 30);
  assert.equal(localDayKey(value), TODAY);
});

test("Today includes only unread entries published on the local day", () => {
  assert.equal(isEntryInSmartFeed(entry(), "today", TODAY), true);
  assert.equal(isEntryInSmartFeed(entry({ status: "read" }), "today", TODAY), false);
  assert.equal(
    isEntryInSmartFeed(entry({ published_at: "2026-08-01T04:00:00.000Z" }), "today", TODAY),
    false,
  );
});

test("All unread includes unread entries from any publication day", () => {
  assert.equal(isEntryInSmartFeed(entry(), "unread", TODAY), true);
  assert.equal(
    isEntryInSmartFeed(entry({ published_at: "2020-01-01T00:00:00.000Z" }), "unread", TODAY),
    true,
  );
  assert.equal(isEntryInSmartFeed(entry({ status: "read" }), "unread", TODAY), false);
});

test("Saved includes starred entries regardless of read status", () => {
  assert.equal(isEntryInSmartFeed(entry({ status: "read", starred: true }), "saved", TODAY), true);
  assert.equal(isEntryInSmartFeed(entry({ starred: false }), "saved", TODAY), false);
});

test("Today sorts by recommendation while All unread sorts newest first", () => {
  const olderRecommended = entry({ published_at: "2026-08-02T01:00:00.000Z", score: 10 });
  const newer = entry({ published_at: "2026-08-02T08:00:00.000Z", score: 1 });

  assert.ok(compareSmartFeedEntries(olderRecommended, newer, "today") < 0);
  assert.ok(compareSmartFeedEntries(olderRecommended, newer, "unread") > 0);
});
