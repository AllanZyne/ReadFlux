import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  incrementalChangedAfter,
  mergeSyncedEntries,
  newestChangedAt,
  normalizeArticleContent,
  normalizeArticleText,
  sameJsonValue,
  syncIntervalElapsed,
} from "../src/entry-sync.ts";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/readflux-client.ts", import.meta.url), "utf8");

test("full entry sync loads the complete Miniflux history in resumable phases", () => {
  assert.doesNotMatch(app, /DEFAULT_LOOKBACK_DAYS|LOOKBACK_OPTIONS|published_after/);
  assert.match(app, /\{\s*id:\s*"unread",\s*filters:\s*\{\s*status:\s*"unread"\s*\}\s*\}/);
  assert.match(app, /\{\s*id:\s*"starred",\s*filters:\s*\{\s*status:\s*"read",\s*starred:\s*"true"\s*\}\s*\}/);
  assert.match(app, /\{\s*id:\s*"read",\s*filters:\s*\{\s*status:\s*"read",\s*starred:\s*"false"\s*\}\s*\}/);
  assert.match(app, /const canResume = storedState\?\.initialSyncComplete === false/);
});

test("entry content and mutable state use separate single-user stores", () => {
  assert.match(client, /DB_VERSION\s*=\s*9/);
  assert.match(client, /ARTICLES\s*=\s*"articles"/);
  assert.match(client, /ARTICLE_STATE\s*=\s*"article-state"/);
  assert.match(client, /SYNC_STATE\s*=\s*"sync-state"/);
  assert.match(client, /OUTBOX\s*=\s*"outbox"/);
  assert.doesNotMatch(client, /entryCacheScope/);
  assert.match(client, /initialSyncComplete:\s*boolean/);
  assert.match(client, /phase\?:\s*EntrySyncPhase/);
  assert.match(client, /offset\?:\s*number/);
  assert.match(client, /incrementalCursor\?:\s*string/);
  assert.match(client, /lastIncrementalSyncAt\?:\s*string/);
  assert.match(client, /lastFullSyncAt\?:\s*string/);
});

test("automatic sync independently schedules incremental and full modes", () => {
  assert.match(app, /settings\.fullSyncIntervalMinutes/);
  assert.match(app, /settings\.incrementalSyncIntervalMinutes/);
  assert.match(app, /syncIntervalElapsed\(syncState\.lastFullSyncAt \?\? syncState\.updatedAt,[\s\S]*?fullSyncIntervalMinutes/);
  assert.match(app, /lastIncrementalSyncAt \?\? syncState\.lastFullSyncAt \?\? syncState\.updatedAt,[\s\S]*?incrementalSyncIntervalMinutes/);
  assert.match(app, /loadRef\.current\(\{\s*background:\s*true,\s*mode\s*\}\)/);
  assert.match(app, /window\.setInterval\(runScheduledSync,\s*60_000\)/);
  assert.match(app, /value=\{settings\[field\]\}/);
  for (const interval of [0, 30, 60, 120, 240, 480]) {
    assert.match(app, new RegExp(`<option value=\\{${interval}\\}>`));
  }
  assert.doesNotMatch(app, /onSyncEntries\("incremental"\)/);
  assert.match(app, /onSyncEntries=\{async \(\) => \{\s*const succeeded = await load\(\{\s*mode:\s*"full"\s*\}\)/);
});

test("incremental sync uses a remote changed-at cursor with an overlap window", () => {
  assert.equal(incrementalChangedAfter("2026-08-17T00:00:10.000Z"), "1786924805");
  assert.equal(incrementalChangedAfter("invalid"), undefined);
  assert.equal(newestChangedAt([
    { id: 1, status: "read", content: "", changed_at: "2026-08-17T01:00:00Z" },
    { id: 2, status: "read", content: "", changed_at: "2026-08-17T03:00:00Z" },
  ]), "2026-08-17T03:00:00Z");
  assert.match(app, /order:\s*"changed_at"/);
  assert.match(app, /changed_after:\s*changedAfter/);
  assert.match(app, /kind:\s*"incremental"/);
});

test("manual intervals never become due", () => {
  assert.equal(syncIntervalElapsed(undefined, 0), false);
  assert.equal(syncIntervalElapsed("2026-08-17T00:00:00Z", 0, Date.parse("2026-08-18T00:00:00Z")), false);
  assert.equal(syncIntervalElapsed("2026-08-17T00:00:00Z", 30, Date.parse("2026-08-17T00:29:59Z")), false);
  assert.equal(syncIntervalElapsed("2026-08-17T00:00:00Z", 30, Date.parse("2026-08-17T00:30:00Z")), true);
});

test("sync data can be reset without deleting profile data or credentials", () => {
  assert.match(client, /export async function resetEntrySync/);
  assert.match(client, /db\.transaction\(\[ARTICLES,\s*ARTICLE_STATE,\s*FEED_ICONS,\s*FEED_CATALOG,\s*SYNC_STATE\],\s*"readwrite"\)/);
  assert.match(client, /\[ARTICLES,\s*ARTICLE_STATE,\s*FEED_ICONS,\s*FEED_CATALOG,\s*SYNC_STATE\]\.forEach/);
  assert.match(app, /t\("sync\.resetData"\)/);
  assert.match(app, /syncResetInProgress\.current\s*=\s*true/);
  assert.match(app, /while\s*\(syncInFlight\.current\)/);
  assert.match(app, /await resetEntrySync\(\)/);
});

test("feed icons use a local cache keyed by Miniflux icon version", () => {
  assert.match(client, /FEED_ICONS\s*=\s*"feed-icons"/);
  assert.match(client, /export async function getCachedFeedIcons/);
  assert.match(client, /export async function putCachedFeedIcons/);
  assert.match(app, /currentIconIds\.get\(icon\.feedId\) === icon\.iconId/);
  assert.match(app, /const uncachedFeeds = withIcons\.filter/);
  assert.match(app, /putCachedFeedIcons\(loadedIcons\)/);
});

test("sidebar metadata is cached locally and refreshed on the sync cadence", () => {
  assert.match(client, /FEED_CATALOG\s*=\s*"feed-catalog"/);
  assert.match(client, /export async function getCachedFeedCatalog/);
  assert.match(client, /export async function saveCachedFeedCatalog/);
  assert.match(client, /db\.transaction\(FEED_CATALOG,\s*"readwrite"\)/);

  // A cold start renders feeds and categories from cache.
  assert.match(app, /getCachedFeedCatalog<Feed, Category>\(\)/);
  assert.match(app, /if \(cachedCatalog\) \{/);
  assert.match(app, /if \(config\.timeZone\) setMinifluxTimeZone\(config\.timeZone\)/);

  // Account, feed, and category requests only run when a sync is due, or when
  // there is no catalog yet to render the sidebar from.
  assert.match(app, /if \(syncMode \|\| !cachedCatalog\) \{/);
  assert.match(app, /saveCachedFeedCatalog<Feed, Category>\(\{/);
});

test("account, feed, and category requests are not issued on every load", () => {
  // Everything before the sync gate runs on every load() call, so these three
  // requests must sit after it. Guards against reintroducing per-load fetches.
  const loadBody = app.slice(
    app.indexOf("const load = useCallback"),
    app.indexOf("if (syncMode || !cachedCatalog)"),
  );
  assert.ok(loadBody.length > 0);
  assert.doesNotMatch(loadBody, /"\/v1\/feeds"/);
  assert.doesNotMatch(loadBody, /"\/v1\/categories"/);
  assert.doesNotMatch(loadBody, /"\/v1\/me"/);
  // The timezone request still must not block the entry sync.
  assert.match(app, /void loadOptionalMinifluxTimeZone\(/);
  assert.doesNotMatch(app, /await loadOptionalMinifluxTimeZone\(/);
});

test("synced data comparison ignores property order but respects array order", () => {
  // Feed objects that serialise their keys differently are still the same feed,
  // so a reordered response must not count as a change.
  assert.equal(
    sameJsonValue({ id: 1, title: "A" }, { title: "A", id: 1 }),
    true,
  );
  assert.equal(
    sameJsonValue(
      [{ id: 1, icon: { feed_id: 1, icon_id: 9 } }],
      [{ icon: { icon_id: 9, feed_id: 1 }, id: 1 }],
    ),
    true,
  );
  // Sidebar ordering comes from the response order, so a reorder is a change.
  assert.equal(sameJsonValue([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 1 }]), false);
  // Real differences are still detected.
  assert.equal(sameJsonValue({ id: 1, title: "A" }, { id: 1, title: "B" }), false);
  assert.equal(sameJsonValue({ id: 1 }, { id: 1, title: "A" }), false);
  assert.equal(sameJsonValue({ id: 1, title: "A" }, { id: 1 }), false);
  assert.equal(sameJsonValue([{ id: 1 }], [{ id: 1 }, { id: 2 }]), false);
  // Null and primitive edges must not throw or report false equality.
  assert.equal(sameJsonValue(null, null), true);
  assert.equal(sameJsonValue(null, {}), false);
  assert.equal(sameJsonValue({}, null), false);
  assert.equal(sameJsonValue({ a: null }, { a: null }), true);
  assert.equal(sameJsonValue({ a: null }, { a: 0 }), false);
  assert.equal(sameJsonValue([], {}), false);
  assert.equal(sameJsonValue(undefined, undefined), true);
  assert.equal(sameJsonValue("a", "a"), true);
  assert.equal(sameJsonValue(1, "1"), false);
});

test("a corrupted stored timezone is discarded instead of formatting dates", () => {
  assert.match(client, /typeof config\.timeZone === "string" && config\.timeZone/);
  assert.match(client, /localStorage\.removeItem\(LOCAL_CONFIG\)/);
});

test("a late timezone response cannot overwrite a newer connection record", () => {
  // The timezone request outlives its load, so it must not rewrite a later
  // connection or the independent feed catalog.
  assert.match(app, /const revision = \+\+catalogRevision\.current/);
  assert.match(app, /revision !== catalogRevision\.current\) return/);
  assert.match(app, /saveConnection\(\{ \.\.\.config, timeZone \}\)/);
  // A connection change invalidates any in-flight timezone write.
  assert.match(app, /catalogRevision\.current \+= 1;\s*\n\s*if \(config\) queueMicrotask/);
  assert.doesNotMatch(app, /saveCachedFeedCatalogTimeZone/);
});

test("repeated loads keep sidebar state identity when nothing changed", () => {
  // Identity churn here re-ran the feed-icon effect and feedMap memo on every
  // load, which is what made a redundant sync so expensive.
  assert.match(app, /function sameCatalogList/);
  // Serialised comparison would churn whenever the response key order changed.
  assert.match(app, /sameJsonValue\(current, next\)/);
  assert.doesNotMatch(app, /JSON\.stringify\(current\)/);
  assert.match(app, /setFeeds\(\(current\) => sameCatalogList\(current, nextFeeds\) \? current : nextFeeds\)/);
  assert.match(
    app,
    /setCategories\(\(current\) => sameCatalogList\(current, nextCategories\) \? current : nextCategories\)/,
  );
  assert.doesNotMatch(app, /setFeeds\(feedData \?\? \[\]\)/);
  assert.doesNotMatch(app, /setCategories\(categoryData \?\? \[\]\)/);
});

test("entry labels keep their identity when the cached labels are unchanged", () => {
  // An unconditional setEntryLabels(new Map) invalidated mergeEntryBatch, which
  // invalidated load, which re-fired the load effect in a loop.
  assert.match(app, /function sameEntryLabels/);
  assert.match(
    app,
    /setEntryLabels\(\(current\) => sameEntryLabels\(current, labels\) \? current : labels\)/,
  );
  assert.doesNotMatch(app, /setEntryLabels\(labels\);/);
});

test("on-demand content caches the same local status and starred state shown in the UI", () => {
  assert.match(app, /const merged = local[\s\S]*status:\s*local\.status,\s*starred:\s*local\.starred/);
  assert.match(app, /putCachedEntries\(\[merged\]\)/);
  assert.doesNotMatch(app, /putCachedEntries\(\[remote\]\)/);
});

test("article details are fetched only when cached content is empty", () => {
  assert.match(app, /if \(!story\.content\.trim\(\)\) void loadEntryContent\(story\.id\)/);
  assert.match(app, /minifluxFetch<Entry>\(config, `\/v1\/entries\/\$\{id\}`\)/);
  assert.doesNotMatch(app, /loadEntryContent\(selectedId,\s*\{ background: true \}\)/);
});

test("manual refresh stays passive and always requests a full entry sync", () => {
  assert.match(app, /const syncSucceeded = await load\(\{\s*mode:\s*"full"\s*\}\)/);
  assert.doesNotMatch(app, /\/v1\/feeds\/refresh/);
});

test("changed read entries are labeled before React state scheduling", () => {
  const cached = [{
    id: 7,
    status: "read",
    content: "<p>Old</p>",
    changed_at: "2026-08-14T01:00:00Z",
  }];
  const remote = [{
    id: 7,
    status: "read",
    content: "<p>Updated</p>",
    changed_at: "2026-08-14T02:00:00Z",
  }];

  const result = mergeSyncedEntries(cached, remote);

  assert.deepEqual([...result.updatedIds], [7]);
  assert.equal(result.entries[0].content, "<p>Updated</p>");
  assert.match(app, /protectPendingEntryMutations\(batch,[\s\S]*?mergeSyncedEntries\(entriesRef\.current,\s*protectedBatch\)/);
  assert.doesNotMatch(app, /setEntries\(\(current\) => \{[\s\S]*?updatedIds\.add/);
});

test("article update detection compares normalized visible content", () => {
  assert.equal(normalizeArticleText("  Ａ\n title  "), "A title");
  assert.equal(
    normalizeArticleContent('<p>Hello <strong>world</strong>&nbsp;&amp; friends&mdash;&copy;&ldquo;quoted&rdquo;</p>'),
    'Hello world & friends—©“quoted”',
  );

  const cached = [{
    id: 8,
    status: "read",
    title: "A  title",
    url: "https://example.com/old",
    author: undefined,
    content: '<p>Hello <strong>world</strong>&mdash;&copy;</p><video src="https://cdn.example/video.mp4?token=old" poster="old.jpg"><a href="https://example.com/watch?id=1">Watch video</a></video><img src="old.jpg" alt="Diagram">',
  }];
  const remote = [{
    id: 8,
    status: "read",
    title: "Ａ title",
    url: "https://example.com/new?tracking=1",
    author: "",
    content: '<div class="new">Hello <b>world</b>—©</div><video src="https://cdn.example/video.mp4?token=new" poster="new.jpg"><a href="https://example.com/watch?id=2">Different fallback text</a></video><img src="new.jpg" alt="Diagram">',
  }];

  assert.deepEqual([...mergeSyncedEntries(cached, remote).updatedIds], []);
});

test("visible text and media structure changes still mark read articles updated", () => {
  const cached = [{
    id: 9,
    status: "read",
    title: "Title",
    content: '<p>Original text</p><img src="one.jpg" alt="First diagram">',
  }];

  const textChanged = [{
    id: 9,
    status: "read",
    title: "Title",
    content: '<p>Revised text</p><img src="two.jpg" alt="First diagram">',
  }];
  const mediaChanged = [{
    id: 9,
    status: "read",
    title: "Title",
    content: '<p>Original text</p><video src="one.mp4"></video>',
  }];

  assert.deepEqual([...mergeSyncedEntries(cached, textChanged).updatedIds], [9]);
  assert.deepEqual([...mergeSyncedEntries(cached, mediaChanged).updatedIds], [9]);
});

test("unread and unchanged entries do not receive update labels", () => {
  const current = [
    { id: 1, status: "unread", content: "old", changed_at: "2026-08-14T01:00:00Z" },
    { id: 2, status: "read", content: "old", changed_at: "2026-08-14T02:00:00Z" },
  ];
  const batch = [
    { id: 1, status: "unread", content: "new", changed_at: "2026-08-14T02:00:00Z" },
    { id: 2, status: "read", content: "old", changed_at: "2026-08-14T02:00:00Z" },
  ];

  assert.deepEqual([...mergeSyncedEntries(current, batch).updatedIds], []);
});

test("entry merging preserves cached content when a sync response omits it", () => {
  const current = [
    { id: 3, status: "read", content: "<p>Cached</p>", changed_at: "2026-08-14T01:00:00Z" },
  ];
  const batch = [
    { id: 3, status: "read", content: "", changed_at: "2026-08-14T01:00:00Z" },
  ];

  const result = mergeSyncedEntries(current, batch);

  assert.equal(result.entries[0].content, "<p>Cached</p>");
  assert.equal(result.mergedBatch[0].content, "<p>Cached</p>");
  assert.match(app, /putCachedEntries\(mergedBatch\)/);
  assert.doesNotMatch(app, /putCachedEntries\(batch\)/);
});
