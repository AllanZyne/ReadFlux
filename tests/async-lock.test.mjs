import assert from "node:assert/strict";
import test from "node:test";

const lockModule = await import("../src/async-lock.ts").catch(() => ({}));

test("profile writes reject overlapping operations and unlock afterward", async () => {
  assert.equal(typeof lockModule.runExclusive, "function");
  const lock = { current: false };
  let release;
  const held = new Promise((resolve) => { release = resolve; });

  const first = lockModule.runExclusive(lock, async () => held);
  const overlapping = await lockModule.runExclusive(lock, async () => "overlap");
  assert.deepEqual(overlapping, { started: false });

  release();
  assert.deepEqual(await first, { started: true, value: undefined });
  assert.deepEqual(await lockModule.runExclusive(lock, async () => "next"), {
    started: true,
    value: "next",
  });
});
