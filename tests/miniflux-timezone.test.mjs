import assert from "node:assert/strict";
import test from "node:test";
import { loadOptionalMinifluxTimeZone } from "../src/miniflux-timezone.mjs";

test("Miniflux account timezone is returned when the profile request succeeds", async () => {
  const timeZone = await loadOptionalMinifluxTimeZone(async () => ({
    timezone: "Asia/Shanghai",
  }));

  assert.equal(timeZone, "Asia/Shanghai");
});

test("timezone request failures fall back without blocking sync", async () => {
  const timeZone = await loadOptionalMinifluxTimeZone(async () => {
    throw new Error("profile unavailable");
  });

  assert.equal(timeZone, undefined);
});
