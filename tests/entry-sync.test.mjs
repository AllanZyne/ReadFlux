import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  incrementalChangedAfter,
  mergeSyncedEntries,
  newestChangedAt,
  normalizeArticleContent,
  normalizeArticleText,
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

test("entry cache is connection-scoped and records resumable sync state", () => {
  assert.match(client, /DB_VERSION\s*=\s*8/);
  assert.match(client, /createIndex\("scope",\s*"scope"\)/);
  assert.match(client, /ENTRY_LABELS\s*=\s*"entry-labels"/);
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
  assert.match(client, /db\.transaction\(\[ENTRY_CACHE,\s*ENTRY_LABELS,\s*FEED_ICONS,\s*SETTINGS\],\s*"readwrite"\)/);
  assert.match(client, /\.openCursor\(IDBKeyRange\.only\(scope\)\)/);
  assert.doesNotMatch(client, /getAllKeys\(scope\)/);
  assert.match(client, /delete\(`entry-sync-state:\$\{scope\}`\)/);
  assert.match(app, /t\("sync\.resetData"\)/);
  assert.match(app, /syncResetInProgress\.current\s*=\s*true/);
  assert.match(app, /while\s*\(syncInFlight\.current\)/);
  assert.match(app, /await resetEntrySync\(config\)/);
});

test("feed icons use a connection-scoped cache keyed by Miniflux icon version", () => {
  assert.match(client, /FEED_ICONS\s*=\s*"feed-icons"/);
  assert.match(client, /export async function getCachedFeedIcons/);
  assert.match(client, /export async function putCachedFeedIcons/);
  assert.match(app, /currentIconIds\.get\(icon\.feedId\) === icon\.iconId/);
  assert.match(app, /const uncachedFeeds = withIcons\.filter/);
  assert.match(app, /putCachedFeedIcons\(config,\s*loadedIcons\)/);
});

test("on-demand content caches the same local status and starred state shown in the UI", () => {
  assert.match(app, /const merged = local[\s\S]*status:\s*local\.status,\s*starred:\s*local\.starred/);
  assert.match(app, /putCachedEntries\(config,\s*\[merged\]\)/);
  assert.doesNotMatch(app, /putCachedEntries\(config,\s*\[remote\]\)/);
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
  assert.match(app, /putCachedEntries\(config,\s*mergedBatch\)/);
  assert.doesNotMatch(app, /putCachedEntries\(config,\s*batch\)/);
});
