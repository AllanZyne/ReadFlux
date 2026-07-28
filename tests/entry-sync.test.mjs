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
