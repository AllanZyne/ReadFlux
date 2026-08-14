import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mergeSyncedEntries } from "../src/entry-sync.ts";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/readflux-client.ts", import.meta.url), "utf8");

test("every entry sync loads the full Miniflux history in resumable phases", () => {
  assert.doesNotMatch(app, /DEFAULT_LOOKBACK_DAYS|LOOKBACK_OPTIONS|published_after|changed_after/);
  assert.match(app, /\{\s*id:\s*"unread",\s*filters:\s*\{\s*status:\s*"unread"\s*\}\s*\}/);
  assert.match(app, /\{\s*id:\s*"starred",\s*filters:\s*\{\s*status:\s*"read",\s*starred:\s*"true"\s*\}\s*\}/);
  assert.match(app, /\{\s*id:\s*"read",\s*filters:\s*\{\s*status:\s*"read",\s*starred:\s*"false"\s*\}\s*\}/);
  assert.match(app, /const canResume = storedState\?\.initialSyncComplete === false/);
});

test("entry cache is connection-scoped and records resumable sync state", () => {
  assert.match(client, /DB_VERSION\s*=\s*4/);
  assert.match(client, /createIndex\("scope",\s*"scope"\)/);
  assert.match(client, /ENTRY_LABELS\s*=\s*"entry-labels"/);
  assert.match(client, /initialSyncComplete:\s*boolean/);
  assert.match(client, /phase\?:\s*EntrySyncPhase/);
  assert.match(client, /offset\?:\s*number/);
});

test("visible background refreshes use the same full entry sync", () => {
  assert.doesNotMatch(app, /changed_after|kind:\s*"incremental"/);
  assert.match(app, /5\s*\*\s*60_000/);
  assert.match(app, /loadRef\.current\(\{\s*background:\s*true\s*\}\)/);
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

test("manual refresh stays passive and uses the same entry sync as background refresh", () => {
  assert.match(app, /const syncSucceeded = await load\(\)/);
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
  assert.match(app, /mergeSyncedEntries\(entriesRef\.current,\s*batch\)/);
  assert.doesNotMatch(app, /setEntries\(\(current\) => \{[\s\S]*?updatedIds\.add/);
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
