import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const eventModule = await import("../src/readflux-client.ts").catch(() => ({}));
const clientSource = await readFile(new URL("../src/readflux-client.ts", import.meta.url), "utf8");

test("empty or invalid reading-event timestamps are rejected before saving", () => {
  assert.equal(typeof eventModule.normalizeReadingEventOpenedAt, "function");
  assert.equal(eventModule.normalizeReadingEventOpenedAt(""), null);
  assert.equal(eventModule.normalizeReadingEventOpenedAt("not-a-date"), null);
  assert.equal(
    eventModule.normalizeReadingEventOpenedAt("2026-08-02T12:34:56Z"),
    "2026-08-02T12:34:56.000Z",
  );
});

test("remote month replacement snapshots old keys before inserting new records", () => {
  const replacement = clientSource.match(/export async function replaceRemoteReadingEventMonth[\s\S]*?\n}\n\nexport async function removeRemoteReadingEventMonth/)?.[0] ?? "";
  assert.match(replacement, /getAllKeys\(IDBKeyRange\.only\(sourceMonth\)\)/);
  assert.doesNotMatch(replacement, /openCursor/);
});
