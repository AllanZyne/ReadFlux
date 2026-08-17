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

test("Today recommends the full synced history regardless of date or read status", () => {
  assert.equal(isEntryInSmartFeed(entry(), "today"), true);
  assert.equal(isEntryInSmartFeed(entry({ status: "read" }), "today"), true);
  assert.equal(isEntryInSmartFeed(entry({ published_at: "2020-01-01T00:00:00Z" }), "today"), true);
  assert.equal(isEntryInSmartFeed(entry({ status: "removed" }), "today"), false);
});

test("Updated contains labeled entries until their update has been viewed", () => {
  const labels = new Map([[1, ["updated"]]]);

  assert.equal(isEntryInSmartFeed(entry({ status: "read" }), "updated", labels), true);
  assert.equal(isEntryInSmartFeed(entry({ id: 2, status: "read" }), "updated", labels), false);
  assert.equal(isEntryInSmartFeed(entry({ status: "removed" }), "updated", labels), false);
});

test("Saved includes starred entries regardless of read status", () => {
  assert.equal(isEntryInSmartFeed(entry({ status: "read", starred: true }), "saved"), true);
  assert.equal(isEntryInSmartFeed(entry({ starred: false }), "saved"), false);
});

test("Today sorts all statuses by recommendation without hard status tiers", () => {
  const olderRecommended = entry({ published_at: localTimestamp(2, 1), score: 10 });
  const newerUpdatedUnread = entry({ id: 2, published_at: localTimestamp(2, 8), score: 1 });
  const labels = new Map([[2, ["updated"]]]);

  assert.ok(compareSmartFeedEntries(olderRecommended, newerUpdatedUnread, "today", labels) < 0);
});

test("Updated sorts by changed time while Saved sorts by publication time", () => {
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
  assert.ok(compareSmartFeedEntries(olderPublicationNewerChange, newerPublicationOlderChange, "saved") > 0);
});

test("smart feed counts cover all active entries and persisted updates", () => {
  const entries = [
    entry(),
    entry({ id: 2, published_at: localTimestamp(1) }),
    entry({ id: 3, status: "read", starred: true }),
    entry({ id: 4, status: "removed", starred: true }),
  ];
  const labels = new Map([[3, ["updated"]], [4, ["updated"]]]);

  assert.deepEqual(countSmartFeedEntries(entries, labels), {
    unreadCount: 2,
    todayCount: 3,
    updatedCount: 1,
    savedCount: 1,
  });
});
