import assert from "node:assert/strict";
import test from "node:test";
import {
  compareSmartFeedEntries,
  countSmartFeedEntries,
  isEntryInSmartFeed,
  localDayKey,
  nextDayBoundary,
  selectTimeZone,
} from "../src/smart-feeds.mjs";

const TODAY = "2026-08-02";
const localTimestamp = (day, hour = 12) => new Date(2026, 7, day, hour).toISOString();

const entry = (overrides = {}) => ({
  status: "unread",
  starred: false,
  published_at: localTimestamp(2),
  score: 0,
  ...overrides,
});

test("localDayKey uses the browser-local calendar date", () => {
  const value = new Date(2026, 7, 2, 23, 30);
  assert.equal(localDayKey(value), TODAY);
});

test("localDayKey can use the Miniflux account timezone", () => {
  const value = new Date("2026-08-01T18:00:00.000Z");

  assert.equal(localDayKey(value, "Asia/Shanghai"), "2026-08-02");
  assert.equal(localDayKey(value, "America/Los_Angeles"), "2026-08-01");
});

test("nextDayBoundary follows the account timezone across daylight saving time", () => {
  assert.equal(
    nextDayBoundary(new Date("2026-08-01T18:00:00.000Z"), "Asia/Shanghai").toISOString(),
    "2026-08-02T16:00:00.000Z",
  );
  assert.equal(
    nextDayBoundary(new Date("2026-03-08T08:00:00.000Z"), "America/Los_Angeles").toISOString(),
    "2026-03-09T07:00:00.000Z",
  );
});

test("selectTimeZone identifies Miniflux and browser timezone sources", () => {
  assert.deepEqual(selectTimeZone("Asia/Shanghai"), {
    timeZone: "Asia/Shanghai",
    source: "miniflux",
  });
  assert.deepEqual(selectTimeZone("Mars/Olympus"), {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    source: "browser",
  });
});

test("Today includes only unread entries published on the local day", () => {
  assert.equal(isEntryInSmartFeed(entry(), "today", TODAY), true);
  assert.equal(isEntryInSmartFeed(entry({ status: "read" }), "today", TODAY), false);
  assert.equal(
    isEntryInSmartFeed(entry({ published_at: localTimestamp(1) }), "today", TODAY),
    false,
  );
});

test("Today uses the Miniflux account timezone for entry membership", () => {
  const value = entry({ published_at: "2026-08-01T18:00:00.000Z" });

  assert.equal(isEntryInSmartFeed(value, "today", "2026-08-02", "Asia/Shanghai"), true);
  assert.equal(
    isEntryInSmartFeed(value, "today", "2026-08-02", "America/Los_Angeles"),
    false,
  );
});

test("All unread includes unread entries from any publication day", () => {
  assert.equal(isEntryInSmartFeed(entry(), "unread", TODAY), true);
  assert.equal(
    isEntryInSmartFeed(
      entry({ published_at: new Date(2020, 0, 1, 12).toISOString() }),
      "unread",
      TODAY,
    ),
    true,
  );
  assert.equal(isEntryInSmartFeed(entry({ status: "read" }), "unread", TODAY), false);
});

test("Saved includes starred entries regardless of read status", () => {
  assert.equal(isEntryInSmartFeed(entry({ status: "read", starred: true }), "saved", TODAY), true);
  assert.equal(isEntryInSmartFeed(entry({ starred: false }), "saved", TODAY), false);
});

test("Today sorts by recommendation while All unread sorts newest first", () => {
  const olderRecommended = entry({ published_at: localTimestamp(2, 1), score: 10 });
  const newer = entry({ published_at: localTimestamp(2, 8), score: 1 });

  assert.ok(compareSmartFeedEntries(olderRecommended, newer, "today") < 0);
  assert.ok(compareSmartFeedEntries(olderRecommended, newer, "unread") > 0);
});

test("smart feed counts are calculated together for the current local day", () => {
  const entries = [
    entry(),
    entry({ published_at: localTimestamp(1) }),
    entry({ status: "read", starred: true }),
  ];

  assert.deepEqual(countSmartFeedEntries(entries, TODAY), {
    unreadCount: 2,
    todayUnreadCount: 1,
    savedCount: 1,
  });
});

test("smart feed counts use the Miniflux account timezone", () => {
  const entries = [entry({ published_at: "2026-08-01T18:00:00.000Z" })];

  assert.equal(
    countSmartFeedEntries(entries, "2026-08-02", "America/Los_Angeles").todayUnreadCount,
    0,
  );
});
