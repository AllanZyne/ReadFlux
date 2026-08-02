import assert from "node:assert/strict";
import test from "node:test";
import {
  loadOptionalMinifluxTimeZone,
  startOptionalMinifluxTimeZoneLoad,
} from "../src/miniflux-timezone.mjs";

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

test("timezone loading can start without blocking the caller", async () => {
  let resolveUser;
  const user = new Promise((resolve) => { resolveUser = resolve; });
  let loadedTimeZone = "pending";

  const result = startOptionalMinifluxTimeZoneLoad(
    () => user,
    (timeZone) => { loadedTimeZone = timeZone; },
  );

  assert.equal(result, undefined);
  assert.equal(loadedTimeZone, "pending");
  resolveUser({ timezone: "Asia/Shanghai" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loadedTimeZone, "Asia/Shanghai");
});
