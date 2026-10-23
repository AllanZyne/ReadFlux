import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { advanceReadingClock, createReadingAttentionTracker, isReadingPointerTarget, MAX_READING_INTERVAL_MS, READING_POINTER_AREAS, readingForegroundActive } from "../src/reading-time.ts";

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

const reading = { closest: () => ({}) };
const elsewhere = { closest: () => null };
const frame = { closest: () => ({}), frame: true };

function attentionHarness({ underMouse = () => elsewhere, fullscreen = () => null, initial = true } = {}) {
  const changes = [];
  const tracker = createReadingAttentionTracker({
    attention: () => changes.at(-1) ?? initial,
    setAttention: (attending) => changes.push(attending),
    fullscreenElement: fullscreen,
    elementFromPoint: (x, y) => underMouse(x, y),
    isFrame: (target) => !!target?.frame,
  });
  return { tracker, last: () => changes.at(-1), changes };
}

const mouse = (type, target, x = 10, y = 20) => ({ type, pointerType: "mouse", clientX: x, clientY: y, target });

test("the mouse decides attention by the reading area it rests on", () => {
  const { tracker, last } = attentionHarness();
  tracker.pointer(mouse("pointermove", reading));
  assert.equal(last(), true);
  tracker.pointer(mouse("pointermove", elsewhere));
  assert.equal(last(), false);
  tracker.pointer({ type: "wheel", clientX: 0, clientY: 0, target: reading });
  assert.equal(last(), true);
  tracker.out({ ...mouse("pointerout", reading), relatedTarget: elsewhere });
  assert.equal(last(), true, "moving between elements is not leaving the window");
  tracker.out({ ...mouse("pointerout", frame), relatedTarget: null });
  assert.equal(last(), true, "moving into an embedded video frame is not leaving the window");
  tracker.out({ ...mouse("pointerout", reading), relatedTarget: null });
  assert.equal(last(), false);
});

test("scrolling the open article's card out from under a resting mouse pauses attention", () => {
  let under = reading;
  const { tracker, last } = attentionHarness({ underMouse: (x, y) => {
    assert.deepEqual([x, y], [10, 20]);
    return under;
  } });
  tracker.pointer({ type: "wheel", clientX: 10, clientY: 20, target: reading });
  assert.equal(last(), true);
  under = elsewhere;
  tracker.scroll();
  assert.equal(last(), false);
  under = reading;
  tracker.scroll();
  assert.equal(last(), true);
});

test("keyboard resumption and touch attention are not overridden by scrolling", () => {
  const { tracker, changes } = attentionHarness();
  tracker.pointer(mouse("pointermove", elsewhere));
  tracker.resume();
  tracker.scroll();
  assert.deepEqual(changes, [false, true]);
  tracker.pointer({ type: "pointermove", pointerType: "touch", clientX: 0, clientY: 0, target: elsewhere });
  assert.deepEqual(changes, [false, true], "touch has no hover");
  tracker.pointer({ type: "pointerdown", pointerType: "touch", clientX: 0, clientY: 0, target: reading });
  tracker.scroll();
  assert.deepEqual(changes, [false, true, true]);
});

test("keys that do not resume reading leave the resting mouse in charge", () => {
  // A list card is focused and PageDown scrolls the open article's card away.
  let under = reading;
  const { tracker, last } = attentionHarness({ underMouse: () => under });
  tracker.pointer(mouse("pointermove", reading));
  under = elsewhere;
  tracker.scroll();
  assert.equal(last(), false);
});

test("a fullscreen article video holds attention wherever the pointer is", () => {
  let fullscreen = null;
  const { tracker, last } = attentionHarness({ fullscreen: () => fullscreen });
  tracker.pointer(mouse("pointermove", elsewhere));
  assert.equal(last(), false);
  fullscreen = reading;
  tracker.fullscreenChange();
  assert.equal(last(), true);
  tracker.pointer(mouse("pointermove", elsewhere));
  assert.equal(last(), true);
  tracker.scroll();
  assert.equal(last(), true);
  tracker.out({ ...mouse("pointerout", elsewhere), relatedTarget: null });
  assert.equal(last(), true);
});

test("leaving fullscreen restores attention from the mouse, or else from before fullscreen", () => {
  let fullscreen = null;
  let under = elsewhere;
  const harness = (initial) => attentionHarness({ fullscreen: () => fullscreen, underMouse: () => under, initial });

  // The mouse rests outside the reading areas once the layout returns.
  const resting = harness(true);
  resting.tracker.pointer(mouse("pointerdown", reading));
  fullscreen = reading;
  resting.tracker.fullscreenChange();
  resting.tracker.pointer(mouse("pointermove", reading));
  fullscreen = null;
  resting.tracker.fullscreenChange();
  assert.equal(resting.last(), false);
  under = reading;
  const onReader = harness(false);
  onReader.tracker.pointer(mouse("pointerdown", elsewhere));
  fullscreen = reading;
  onReader.tracker.fullscreenChange();
  fullscreen = null;
  onReader.tracker.fullscreenChange();
  assert.equal(onReader.last(), true);

  // Without a mouse position, the attention from before fullscreen returns.
  for (const before of [true, false]) {
    const keyboard = harness(before);
    fullscreen = reading;
    keyboard.tracker.fullscreenChange();
    fullscreen = null;
    keyboard.tracker.fullscreenChange();
    assert.equal(keyboard.last(), before);
  }

  // Keyboard reading during fullscreen resumes attention for after it.
  const resumed = harness(true);
  resumed.tracker.pointer(mouse("pointermove", elsewhere));
  fullscreen = reading;
  resumed.tracker.fullscreenChange();
  resumed.tracker.resume();
  fullscreen = null;
  resumed.tracker.fullscreenChange();
  assert.equal(resumed.last(), true);

  // The mouse left the window during fullscreen.
  const left = harness(true);
  left.tracker.pointer(mouse("pointerdown", reading));
  fullscreen = reading;
  left.tracker.fullscreenChange();
  left.tracker.out({ ...mouse("pointerout", reading), relatedTarget: null });
  fullscreen = null;
  left.tracker.fullscreenChange();
  assert.equal(left.last(), false);

  // A fullscreen change that never involved the article leaves attention alone.
  const unrelated = harness(true);
  unrelated.tracker.fullscreenChange();
  assert.deepEqual(unrelated.changes, []);
});

test("the reader wires attention into the clock and resumes it from the keyboard", () => {
  assert.match(appSource, /!!current && readerAttention\.current && readingForegroundActive\(document\)/);
  assert.match(appSource, /const elapsedSeconds = syncReadingClock\(\);\s*readerAttention\.current = attending;\s*syncReadingClock\(\);/);
  assert.match(appSource, /createReadingAttentionTracker\(\{\s*attention: \(\) => readerAttention\.current,\s*setAttention: setReaderAttention,/);
  for (const [type, handler] of [["pointermove", "pointer"], ["pointerdown", "pointer"], ["wheel", "pointer"], ["pointerout", "out"], ["scroll", "scroll"], ["fullscreenchange", "fullscreenChange"]]) {
    assert.match(appSource, new RegExp(`document\\.addEventListener\\("${type}", tracker\\.${handler}\\b`));
  }
  assert.doesNotMatch(appSource, /addEventListener\("keydown", tracker\./);
  assert.match(appSource, /readerAttention\.current = true;\s*attentionTracker\.current\?\.resume\(\);\s*activeEvent\.current = readingEvent;/);
  assert.match(appSource, /resumeReaderAttention\(\);\s*reader\.scrollBy/);
  // Capture runs before reader controls such as the AI buttons stop propagation.
  assert.match(appSource, /<article className="reader" onKeyDownCapture=\{resumeReaderAttention\}>/);
});
