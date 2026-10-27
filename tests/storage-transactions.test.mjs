import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import {
  claimEntryMutations,
  completeEntryMutations,
  getCachedEntries,
  getCachedFeedIcons,
  getEntryLabels,
  getEntryMutations,
  getProfileSettings,
  putCachedEntries,
  putEntryLabels,
  queueEntryMutations,
  resetEntrySync,
  retryEntryMutations,
  saveProfileSettings,
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

test("entry labels commit per label without changing article state", async () => {
  const entries = [entry(1, { status: "read", starred: true }), entry(2)];
  const at = "2026-10-27T08:00:00.000Z";
  await putCachedEntries(entries);
  await putEntryLabels("updated", [[1, at]]);
  await putEntryLabels("later", [[1, at], [2, at], [999, at]]);
  assert.deepEqual(await getEntryLabels(), new Map([[1, { updated: at, later: at }], [2, { later: at }], [999, { later: at }]]));
  await putEntryLabels("updated", [[1, null], [2, null]]);
  await putEntryLabels("later", [[999, null]]);
  await putEntryLabels("later", []);
  assert.deepEqual(await getEntryLabels(), new Map([[1, { later: at }], [2, { later: at }]]));
  assert.deepEqual(await getCachedEntries(), entries);
});

test("resetting sync clears Updated labels and keeps Read later tags", async () => {
  const at = "2026-10-27T08:00:00.000Z";
  await putCachedEntries([entry(1, { status: "read" })]);
  await putEntryLabels("updated", [[1, at]]);
  await putEntryLabels("later", [[1, at]]);
  await resetEntrySync();
  assert.deepEqual(await getCachedEntries(), []);
  assert.deepEqual(await getEntryLabels(), new Map([[1, { later: at }]]));
});

test("the schema upgrade moves the Updated flag from article state into labels", async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.open("readflux-profile", 10);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("articles", { keyPath: "id" }).put({ id: 1, article: { content: "Body" } });
      const state = request.result.createObjectStore("article-state", { keyPath: "entryId" });
      state.put({ entryId: 1, status: "read", starred: false, updated: true });
      state.put({ entryId: 2, status: "unread", starred: false, updated: false });
    };
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
  const labels = await getEntryLabels();
  assert.deepEqual([...labels.keys()], [1]);
  assert.equal(typeof labels.get(1)?.updated, "string");
  assert.equal(labels.get(1)?.later, undefined);
  const cached = await getCachedEntries();
  assert.deepEqual(cached, [{ content: "Body", id: 1, status: "read", starred: false }]);
});

test("the schema upgrade tags the unread links of the old Read later queue at their save time", async () => {
  const savedAt = "2026-10-20T08:00:00.000Z";
  await new Promise((resolve, reject) => {
    const request = indexedDB.open("readflux-profile", 10);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("feed-catalog", { keyPath: "id" }).put({
        id: "catalog",
        feeds: [{ id: 9, feed_url: "https://reader.example/readflux-read-later.xml" }, { id: 1, feed_url: "https://blog.example/feed.xml" }],
        categories: [],
        savedAt,
      });
      const articles = db.createObjectStore("articles", { keyPath: "id" });
      const state = db.createObjectStore("article-state", { keyPath: "entryId" });
      [
        [5, 9, "unread", false],
        [6, 9, "read", true],
        [7, 9, "read", false],
        [8, 1, "unread", false],
      ].forEach(([id, feedId, status, starred]) => {
        articles.put({ id, article: { feed_id: feedId, published_at: savedAt, content: "" } });
        state.put({ entryId: id, status, starred, updated: false });
      });
    };
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
  // Read links had left the old queue; a starred one is still in Saved.
  assert.deepEqual(await getEntryLabels(), new Map([[5, { later: savedAt }]]));
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
