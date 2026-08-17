import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  entryMutationPatches,
  groupEntryMutations,
  protectPendingEntryMutations,
} from "../src/entry-mutation-sync.ts";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../src/readflux-client.ts", import.meta.url), "utf8");
const sync = await readFile(new URL("../src/entry-mutation-sync.ts", import.meta.url), "utf8");

const mutation = (entryId, field, value, updatedAt = "2026-08-17T00:00:00Z") => ({
  key: `scope:${entryId}:${field}`,
  scope: "scope",
  revision: crypto.randomUUID(),
  state: "pending",
  updatedAt,
  entryId,
  field,
  value,
});

test("pending read and starred mutations protect their fields during remote reconciliation", () => {
  const patches = entryMutationPatches([
    mutation(7, "status", "read"),
    mutation(7, "starred", true),
  ]);
  const protectedEntries = protectPendingEntryMutations([
    { id: 7, status: "unread", starred: false, content: "remote" },
    { id: 8, status: "unread", starred: false, content: "unchanged" },
  ], patches);

  assert.deepEqual(protectedEntries, [
    { id: 7, status: "read", starred: true, content: "remote" },
    { id: 8, status: "unread", starred: false, content: "unchanged" },
  ]);
});

test("outbox uploads are grouped by field and target value in chunks of 1000", () => {
  const mutations = Array.from({ length: 1001 }, (_, index) => mutation(index, "status", "read"));
  mutations.push(mutation(2000, "status", "unread"), mutation(2001, "starred", true));
  const groups = groupEntryMutations(mutations);

  assert.deepEqual(groups.map((group) => group.length), [1000, 1, 1, 1]);
  groups.forEach((group) => {
    assert.equal(new Set(group.map((item) => `${item.field}:${item.value}`)).size, 1);
  });
  assert.doesNotMatch(sync, /groups\.set\(key,\s*\[\.\.\./);
});

test("entry cache and outbox mutations are persisted atomically with revision-safe completion", () => {
  assert.match(client, /db\.transaction\(\[ENTRY_CACHE,\s*ENTRY_MUTATIONS\],\s*"readwrite"\)/);
  assert.match(client, /revision:\s*crypto\.randomUUID\(\)/);
  assert.match(client, /current\?\.revision !== mutation\.revision/);
  assert.match(client, /state:\s*"pending"/);
});

test("local mutations retry without blocking article refresh", () => {
  assert.match(sync, /claimEntryMutations\(config\)/);
  assert.match(sync, /completeEntryMutations\(config,\s*group\)/);
  assert.match(sync, /retryEntryMutations\(config,\s*group\)/);
  assert.match(app, /await flushPendingEntryMutations\(\);\s*\} catch \{ \/\* pending local state remains protected/);
  assert.match(app, /2 \* 60_000/);
  assert.doesNotMatch(app, /\/bookmark/);
  assert.doesNotMatch(sync, /\/bookmark/);
});

test("read, starred, and bulk-read actions enter the durable outbox", () => {
  assert.match(app, /queueEntryMutations\(config,\s*\[updated\],\s*\[mutation\]\)/);
  assert.match(app, /ids\.map\(\(entryId\) => \(\{ entryId, field: "status", value: "read" \}\)\)/);
  assert.match(sync, /\[mutation\.field\]:\s*mutation\.value/);
  assert.match(app, /else if \(patch\.starred !== undefined\)[\s\S]*?else return false;/);
});
