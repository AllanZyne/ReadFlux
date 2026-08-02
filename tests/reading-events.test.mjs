import assert from "node:assert/strict";
import test from "node:test";

const eventModule = await import("../src/readflux-client.ts").catch(() => ({}));

test("empty or invalid reading-event timestamps are rejected before saving", () => {
  assert.equal(typeof eventModule.normalizeReadingEventOpenedAt, "function");
  assert.equal(eventModule.normalizeReadingEventOpenedAt(""), null);
  assert.equal(eventModule.normalizeReadingEventOpenedAt("not-a-date"), null);
  assert.equal(
    eventModule.normalizeReadingEventOpenedAt("2026-08-02T12:34:56Z"),
    "2026-08-02T12:34:56.000Z",
  );
});
