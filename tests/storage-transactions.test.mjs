import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import {
  claimEntryMutations,
  completeEntryMutations,
  getCachedEntries,
  getCachedFeedIcons,
  getEntryMutations,
  getProfileSettings,
  putCachedEntries,
  queueEntryMutations,
  retryEntryMutations,
  saveProfileSettings,
  setArticleUpdated,
} from "../src/readflux-client.ts";

beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });

const entry = (id, patch = {}) => ({ id, status: "unread", starred: false, content: "Cached body", ...patch });
const read = (entryId, value = "read") => ({ entryId, field: "status", value });

test("schema upgrades preserve compatible feed icons and replace only the legacy key layout", async () => {
  const icon = { feedId: 1, iconId: 2, src: "data:image/png;base64,test" };
  for (const keyPath of ["feedId", "key"]) {
    globalThis.indexedDB = new IDBFactory();
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("readflux-profile", 8);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("feed-icons", { keyPath }).put(
          keyPath === "key" ? { ...icon, key: "legacy:1", scope: "legacy" } : icon,
        );
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    assert.deepEqual(await getCachedFeedIcons(), keyPath === "feedId" ? [icon] : []);
  }
});

test("profile settings can be loaded and normalized without browser localStorage", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined });
  try {
    const settings = await getProfileSettings();
    assert.equal(settings.theme, "day");
    assert.equal(settings.markReadOnScroll, true);
    await saveProfileSettings(settings);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});

test("Updated writes commit for single and multiple articles without changing other state", async () => {
  const entries = [entry(1, { status: "read", starred: true }), entry(2)];
  await putCachedEntries(entries);
  await setArticleUpdated([1], true);
  assert.deepEqual(await getCachedEntries(), [{ ...entries[0], updated: true }, entries[1]]);
  await setArticleUpdated([1, 2, 999], true);
  assert.deepEqual(await getCachedEntries(), entries.map((item) => ({ ...item, updated: true })));
  await setArticleUpdated([1, 2], false);
  assert.deepEqual(await getCachedEntries(), entries);
  await setArticleUpdated([], true);
  await setArticleUpdated([999], true);
  assert.deepEqual(await getCachedEntries(), entries);
});

test("claims commit sending state and recover previously sending mutations", async () => {
  assert.deepEqual(await claimEntryMutations(), []);
  const queued = await queueEntryMutations([entry(1, { status: "read" })], [read(1)]);
  const claimed = await claimEntryMutations();
  assert.deepEqual(claimed, queued.map((item) => ({ ...item, state: "sending" })));
  assert.deepEqual(await getEntryMutations(), claimed);
  assert.deepEqual(await claimEntryMutations(), claimed);
  await retryEntryMutations(claimed);
  assert.deepEqual(await getEntryMutations(), queued);
  await completeEntryMutations(await claimEntryMutations());
  assert.deepEqual(await getEntryMutations(), []);
  await completeEntryMutations(claimed); // already removed
  await retryEntryMutations([]);
  assert.deepEqual(await getEntryMutations(), []);
});

test("late completion and retry preserve newer mutations while processing the rest of a batch", async () => {
  await queueEntryMutations([entry(1), entry(2)], [read(1), read(2)]);
  const oldClaim = await claimEntryMutations();
  const newer = await queueEntryMutations([entry(1)], [read(1, "unread")]);
  await retryEntryMutations(oldClaim);
  assert.deepEqual(await getEntryMutations(), [newer[0], { ...oldClaim[1], state: "pending" }]);
  await completeEntryMutations(oldClaim);
  assert.deepEqual(await getEntryMutations(), newer);
  await completeEntryMutations(await claimEntryMutations());
  assert.deepEqual(await getEntryMutations(), []);
});
