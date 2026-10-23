import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { advanceReadingClock, isReadingPointerTarget, MAX_READING_INTERVAL_MS, READING_POINTER_AREAS, readingForegroundActive } from "../src/reading-time.ts";

const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

test("the reading clock credits real elapsed foreground time to the open event", () => {
  const started = advanceReadingClock(null, "event-1", true, 1_000);
  assert.deepEqual(started, { clock: { eventId: "event-1", since: 1_000 }, elapsedSeconds: 0 });
  const ticked = advanceReadingClock(started.clock, "event-1", true, 2_350);
  assert.equal(ticked.elapsedSeconds, 1.35);
  assert.deepEqual(ticked.clock, { eventId: "event-1", since: 2_350 });
});

test("pausing closes the period and resuming starts from the resume time", () => {
  const paused = advanceReadingClock({ eventId: "event-1", since: 0 }, "event-1", false, 700);
  assert.deepEqual(paused, { clock: null, elapsedSeconds: 0.7 });
  const idle = advanceReadingClock(paused.clock, "event-1", false, 60_000);
  assert.deepEqual(idle, { clock: null, elapsedSeconds: 0 });
  const resumed = advanceReadingClock(idle.clock, "event-1", true, 61_000);
  assert.deepEqual(resumed, { clock: { eventId: "event-1", since: 61_000 }, elapsedSeconds: 0 });
});

test("time never moves to a different event and suspended timers are capped", () => {
  const switched = advanceReadingClock({ eventId: "event-1", since: 0 }, "event-2", true, 3_000);
  assert.deepEqual(switched, { clock: { eventId: "event-2", since: 3_000 }, elapsedSeconds: 0 });
  const closed = advanceReadingClock({ eventId: "event-1", since: 0 }, null, true, 3_000);
  assert.deepEqual(closed, { clock: null, elapsedSeconds: 0 });
  const suspended = advanceReadingClock({ eventId: "event-1", since: 0 }, "event-1", true, 600_000);
  assert.equal(suspended.elapsedSeconds, MAX_READING_INTERVAL_MS / 1000);
  assert.equal(advanceReadingClock({ eventId: "event-1", since: 5_000 }, "event-1", true, 4_000).elapsedSeconds, 0);
});

test("foreground reading requires a visible, focused page without an open modal", () => {
  const doc = (visibilityState, focused, modal) => ({
    visibilityState,
    hasFocus: () => focused,
    querySelector: () => modal ? {} : null,
  });
  assert.equal(readingForegroundActive(doc("visible", true, false)), true);
  assert.equal(readingForegroundActive(doc("hidden", true, false)), false);
  assert.equal(readingForegroundActive(doc("visible", false, false)), false);
  assert.equal(readingForegroundActive(doc("visible", true, true)), false);
});

test("the reader accumulates timestamps and flushes on pause, leave, and visibility changes", () => {
  assert.doesNotMatch(appSource, /activeSeconds \+= 5|seconds \+ 5/);
  assert.match(appSource, /advanceReadingClock\(\s*readingClock\.current,[\s\S]*?performance\.now\(\)/);
  assert.match(appSource, /const commitActiveEvent = useCallback\(\(\) => \{\s*syncReadingClock\(\);/);
  assert.match(appSource, /addEventListener\("visibilitychange", visibilityChange\)/);
  assert.match(appSource, /addEventListener\("blur", pause\)/);
  assert.match(appSource, /addEventListener\("pagehide", flush\)/);
  assert.match(appSource, /now - lastReadingPersist\.current >= READING_PERSIST_MS/);
  assert.match(appSource, /activeEvent\.current = readingEvent;\s*syncReadingClock\(\);/);
});

test("only the reader and the open article's list card hold reading attention", () => {
  const element = (matches) => ({ closest: (selector) => {
    assert.equal(selector, READING_POINTER_AREAS);
    return matches ? {} : null;
  } });
  assert.equal(isReadingPointerTarget(element(true)), true);
  assert.equal(isReadingPointerTarget(element(false)), false);
  assert.equal(isReadingPointerTarget(null), false);
  assert.equal(isReadingPointerTarget({}), false);
  assert.match(READING_POINTER_AREAS, /\.reader\b/);
  assert.match(READING_POINTER_AREAS, /\.story\.selected\b/);
});

test("the mouse leaving the reading areas pauses the open article's clock", () => {
  assert.match(appSource, /!!current && readerAttention\.current && readingForegroundActive\(document\)/);
  assert.match(appSource, /const elapsedSeconds = syncReadingClock\(\);\s*readerAttention\.current = attending;\s*syncReadingClock\(\);/);
  assert.match(appSource, /setReaderAttention\(fullscreenReading\(\) \|\| isReadingPointerTarget\(event\.target\)\)/);
  assert.match(appSource, /const fullscreenReading = \(\) => isReadingPointerTarget\(document\.fullscreenElement\);/);
  assert.match(appSource, /document\.addEventListener\("fullscreenchange", fullscreenChange\)/);
  for (const type of ["pointermove", "pointerdown", "wheel"]) {
    assert.match(appSource, new RegExp(`document\\.addEventListener\\("${type}", follow`));
  }
  assert.match(appSource, /event\.type === "pointermove" && event\.pointerType !== "mouse"\) return;/);
  assert.match(appSource, /document\.addEventListener\("pointerout", leave\)/);
  assert.match(appSource, /!event\.relatedTarget && !\(event\.target instanceof HTMLIFrameElement\)/);
  assert.match(appSource, /readerAttention\.current = true;\s*activeEvent\.current = readingEvent;/);
  assert.match(appSource, /setReaderAttention\(true\);\s*reader\.scrollBy/);
  assert.match(appSource, /<article className="reader" onKeyDown=\{\(\) => setReaderAttention\(true\)\}>/);
});
