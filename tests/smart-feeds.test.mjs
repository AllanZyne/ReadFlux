import assert from "node:assert/strict";
import test from "node:test";
import {
  compareSmartFeedEntries,
  countSmartFeedEntries,
  formatZonedDateTime,
  formatZonedTime,
  isEntryInSmartFeed,
  localDayKey,
  nextDayBoundary,
  selectTimeZone,
  smartFeedStatusPriority,
  smartFeedTimeBucket,
  toZonedDateTimeInput,
  zonedDateTimeInputToIso,
} from "../src/smart-feeds.mjs";

const TODAY = "2026-08-02";
const localTimestamp = (day, hour = 12) => new Date(2026, 7, day, hour).toISOString();

const entry = (overrides = {}) => ({
  id: 1,
  status: "unread",
  starred: false,
  published_at: localTimestamp(2),
  changed_at: localTimestamp(2),
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

test("reader timestamps are formatted in the Miniflux account timezone", () => {
  const value = "2026-08-01T18:00:00.000Z";

  assert.equal(formatZonedTime(value, "Asia/Shanghai"), "02:00");
  assert.equal(formatZonedDateTime(value, "Asia/Shanghai"), "2026/08/02 02:00:00");
});

test("invalid timestamps use stable display fallbacks", () => {
  assert.equal(formatZonedTime("not-a-date", "Asia/Shanghai"), "--:--");
  assert.equal(formatZonedDateTime("", "Asia/Shanghai"), "—");
  assert.equal(toZonedDateTimeInput("not-a-date", "Asia/Shanghai"), "");
  assert.equal(localDayKey("not-a-date", "Asia/Shanghai"), "");
});

test("datetime-local values round-trip through the Miniflux account timezone", () => {
  const value = "2026-08-01T18:00:00.000Z";

  assert.equal(toZonedDateTimeInput(value, "Asia/Shanghai"), "2026-08-02T02:00");
  assert.equal(
    zonedDateTimeInputToIso("2026-08-02T02:00", "Asia/Shanghai"),
    value,
  );
});

test("nonexistent daylight-saving input times advance to the next valid wall time", () => {
  assert.equal(
    zonedDateTimeInputToIso("2026-03-08T02:30", "America/Los_Angeles"),
    "2026-03-08T10:30:00.000Z",
  );
});

test("ambiguous daylight-saving input preserves the existing occurrence", () => {
  const laterOccurrence = "2026-11-01T09:30:00.000Z";
  const input = toZonedDateTimeInput(laterOccurrence, "America/Los_Angeles");

  assert.equal(input, "2026-11-01T01:30");
  assert.equal(
    zonedDateTimeInputToIso(input, "America/Los_Angeles", laterOccurrence),
    laterOccurrence,
  );
  assert.equal(
    zonedDateTimeInputToIso(input, "America/Los_Angeles"),
    "2026-11-01T08:30:00.000Z",
  );
});

test("Today contains unread and updated entries only", () => {
  const labels = new Map([[2, ["updated"]]]);

  assert.equal(isEntryInSmartFeed(entry(), "today"), true);
  assert.equal(isEntryInSmartFeed(entry({ id: 2, status: "read" }), "today", labels), true);
  assert.equal(isEntryInSmartFeed(entry({ id: 3, status: "read" }), "today", labels), false);
  assert.equal(isEntryInSmartFeed(entry({ status: "removed" }), "today"), false);
});

test("Today status priority reflects unread before updated", () => {
  const labels = new Map([[2, ["updated"]], [3, ["updated"]]]);

  assert.equal(smartFeedStatusPriority(entry({ id: 1 }), labels), 2);
  assert.equal(smartFeedStatusPriority(entry({ id: 2, status: "read" }), labels), 1);
  assert.equal(smartFeedStatusPriority(entry({ id: 3 }), labels), 2);
  assert.equal(smartFeedStatusPriority(entry({ id: 4, status: "read" }), labels), 0);
});

test("All contains the complete active history", () => {
  assert.equal(isEntryInSmartFeed(entry(), "all"), true);
  assert.equal(isEntryInSmartFeed(entry({ status: "read" }), "all"), true);
  assert.equal(isEntryInSmartFeed(entry({ status: "removed" }), "all"), false);
});

test("Updated contains labeled entries until their update has been viewed", () => {
  const labels = new Map([[1, ["updated"]], [3, ["updated"]]]);

  assert.equal(isEntryInSmartFeed(entry({ status: "read" }), "updated", labels), true);
  assert.equal(isEntryInSmartFeed(entry({ id: 2, status: "read" }), "updated", labels), false);
  assert.equal(isEntryInSmartFeed(entry({ id: 3 }), "updated", labels), false);
  assert.equal(isEntryInSmartFeed(entry({ status: "removed" }), "updated", labels), false);
});

test("Saved includes starred entries regardless of read status", () => {
  assert.equal(isEntryInSmartFeed(entry({ status: "read", starred: true }), "saved"), true);
  assert.equal(isEntryInSmartFeed(entry({ starred: false }), "saved"), false);
});

test("Today time buckets follow account-local calendar boundaries", () => {
  const now = "2026-08-19T12:00:00+08:00";
  const timeZone = "Asia/Shanghai";

  assert.equal(smartFeedTimeBucket("2026-08-19T01:00:00Z", now, timeZone), 0);
  assert.equal(smartFeedTimeBucket("2026-08-18T01:00:00Z", now, timeZone), 1);
  assert.equal(smartFeedTimeBucket("2026-08-17T01:00:00Z", now, timeZone), 2);
  assert.equal(smartFeedTimeBucket("2026-08-10T01:00:00Z", now, timeZone), 3);
  assert.equal(smartFeedTimeBucket("2026-07-10T01:00:00Z", now, timeZone), 4);
  assert.equal(smartFeedTimeBucket("2025-12-31T01:00:00Z", now, timeZone), 5);
});

test("Today treats Monday as the start of the current week", () => {
  const now = "2026-08-19T12:00:00+08:00";

  assert.equal(smartFeedTimeBucket("2026-08-17T12:00:00+08:00", now, "Asia/Shanghai"), 2);
  assert.equal(smartFeedTimeBucket("2026-08-16T12:00:00+08:00", now, "Asia/Shanghai"), 3);
});

test("Today sorting prioritizes time tier before unread status and recommendation", () => {
  const context = { now: "2026-08-19T12:00:00+08:00", timeZone: "Asia/Shanghai" };
  const todayReadLowScore = entry({
    status: "read",
    published_at: "2026-08-19T01:00:00Z",
    score: 1,
  });
  const yesterdayUnreadHighScore = entry({
    id: 2,
    published_at: "2026-08-18T01:00:00Z",
    score: 100,
  });

  assert.ok(compareSmartFeedEntries(todayReadLowScore, yesterdayUnreadHighScore, "today", undefined, context) < 0);
});

test("Today sorting puts unread entries first within a time tier", () => {
  const context = { now: "2026-08-19T12:00:00+08:00", timeZone: "Asia/Shanghai" };
  const unreadLowScore = entry({
    published_at: "2026-08-19T01:00:00Z",
    score: 1,
  });
  const readHighScore = entry({
    id: 2,
    status: "read",
    published_at: "2026-08-19T02:00:00Z",
    score: 100,
  });

  assert.ok(compareSmartFeedEntries(unreadLowScore, readHighScore, "today", undefined, context) < 0);
});

test("Today sorting uses recommendation then publication time within a status tier", () => {
  const context = { now: "2026-08-19T12:00:00+08:00", timeZone: "Asia/Shanghai" };
  const olderRecommended = entry({
    published_at: "2026-08-19T01:00:00Z",
    score: 10,
  });
  const newerLowerScore = entry({
    id: 2,
    published_at: "2026-08-19T02:00:00Z",
    score: 1,
  });
  const newerEqualScore = entry({
    id: 3,
    published_at: "2026-08-19T03:00:00Z",
    score: 10,
  });

  assert.ok(compareSmartFeedEntries(olderRecommended, newerLowerScore, "today", undefined, context) < 0);
  assert.ok(compareSmartFeedEntries(olderRecommended, newerEqualScore, "today", undefined, context) > 0);
});

test("Today sorting can reuse precomputed time buckets", () => {
  const newer = entry({
    published_at: "2026-08-19T02:00:00Z",
    score: 1,
  });
  const older = entry({
    id: 2,
    published_at: "2026-08-18T02:00:00Z",
    score: 100,
  });
  const context = {
    now: "2026-08-19T12:00:00+08:00",
    timeZone: "Asia/Shanghai",
    timeBuckets: new Map([[newer.id, 1], [older.id, 0]]),
  };

  assert.ok(compareSmartFeedEntries(newer, older, "today", undefined, context) > 0);
});

test("Today time tiers use the configured timezone", () => {
  const now = "2026-08-19T08:30:00Z";
  const published = "2026-08-18T23:30:00Z";

  assert.equal(smartFeedTimeBucket(published, now, "Asia/Shanghai"), 0);
  assert.equal(smartFeedTimeBucket(published, now, "America/Los_Angeles"), 1);
});

test("Updated sorts by changed time while All and Saved sort by publication time", () => {
  const olderPublicationNewerChange = entry({
    id: 1,
    published_at: localTimestamp(1),
    changed_at: localTimestamp(2, 9),
  });
  const newerPublicationOlderChange = entry({
    id: 2,
    published_at: localTimestamp(2),
    changed_at: localTimestamp(2, 8),
  });

  assert.ok(compareSmartFeedEntries(olderPublicationNewerChange, newerPublicationOlderChange, "updated") < 0);
  assert.ok(compareSmartFeedEntries(olderPublicationNewerChange, newerPublicationOlderChange, "all") > 0);
  assert.ok(compareSmartFeedEntries(olderPublicationNewerChange, newerPublicationOlderChange, "saved") > 0);
});

test("smart feed counts cover all active entries and persisted updates", () => {
  const entries = [
    entry(),
    entry({ id: 2, published_at: localTimestamp(1) }),
    entry({ id: 3, status: "read", starred: true }),
    entry({ id: 4, status: "removed", starred: true }),
  ];
  const labels = new Map([[1, ["updated"]], [3, ["updated"]], [4, ["updated"]]]);

  assert.deepEqual(countSmartFeedEntries(entries, labels), {
    unreadCount: 2,
    todayCount: 3,
    allCount: 3,
    updatedCount: 1,
    savedCount: 1,
  });
});
