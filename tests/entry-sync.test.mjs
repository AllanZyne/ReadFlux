import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/readflux-client.ts", import.meta.url), "utf8");

test("entry sync defaults to 30 days and keeps starred entries outside the cutoff", () => {
  assert.match(app, /DEFAULT_LOOKBACK_DAYS\s*=\s*30/);
  assert.match(app, /\{\s*id:\s*"unread",\s*filters:\s*\{\s*status:\s*"unread",\s*\.\.\.publishedAfter\s*\}\s*\}/);
  assert.match(app, /\{\s*id:\s*"starred",\s*filters:\s*\{\s*starred:\s*"true"\s*\}\s*\}/);
  assert.match(app, /\{\s*id:\s*"read",\s*filters:\s*\{\s*status:\s*"read",\s*starred:\s*"false",\s*\.\.\.publishedAfter\s*\}\s*\}/);
});

test("entry cache is connection-scoped and records resumable sync state", () => {
  assert.match(client, /DB_VERSION\s*=\s*2/);
  assert.match(client, /createIndex\("scope",\s*"scope"\)/);
  assert.match(client, /initialSyncComplete:\s*boolean/);
  assert.match(client, /phase\?:\s*EntrySyncPhase/);
  assert.match(client, /offset\?:\s*number/);
});

test("later refreshes use the Miniflux changed-after filter", () => {
  assert.match(app, /changed_after:\s*String\(changedAfter\)/);
  assert.match(app, /5\s*\*\s*60_000/);
});

test("sync data can be reset without deleting profile data or credentials", () => {
  assert.match(client, /export async function resetEntrySync/);
  assert.match(client, /db\.transaction\(\[ENTRY_CACHE,\s*SETTINGS\],\s*"readwrite"\)/);
  assert.match(client, /\.openCursor\(IDBKeyRange\.only\(scope\)\)/);
  assert.doesNotMatch(client, /getAllKeys\(scope\)/);
  assert.match(client, /delete\(`entry-sync-state:\$\{scope\}`\)/);
  assert.match(app, /重置同步数据/);
  assert.match(app, /syncResetInProgress\.current\s*=\s*true/);
  assert.match(app, /while\s*\(syncInFlight\.current\)/);
  assert.match(app, /await resetEntrySync\(config\)/);
});

test("on-demand content caches the same local status and starred state shown in the UI", () => {
  assert.match(app, /const merged = local[\s\S]*status:\s*local\.status,\s*starred:\s*local\.starred/);
  assert.match(app, /putCachedEntries\(config,\s*\[merged\]\)/);
  assert.doesNotMatch(app, /putCachedEntries\(config,\s*\[remote\]\)/);
});
