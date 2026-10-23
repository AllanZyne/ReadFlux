export const READING_TICK_MS = 1000;
export const READING_PERSIST_MS = 5000;
export const MAX_READING_INTERVAL_MS = 5000;

export type ReadingClock = { eventId: string; since: number } | null;

export function advanceReadingClock(
  clock: ReadingClock,
  eventId: string | null,
  active: boolean,
  now: number,
): { clock: ReadingClock; elapsedSeconds: number } {
  const elapsedMs = clock && clock.eventId === eventId
    ? Math.min(MAX_READING_INTERVAL_MS, Math.max(0, now - clock.since))
    : 0;
  return {
    clock: active && eventId ? { eventId, since: now } : null,
    elapsedSeconds: elapsedMs / 1000,
  };
}

/** The reader panel and the open article's card in the list. */
export const READING_POINTER_AREAS = ".reader, .story.selected";

export function isReadingPointerTarget(target: EventTarget | null) {
  return typeof (target as Element | null)?.closest === "function"
    && (target as Element).closest(READING_POINTER_AREAS) !== null;
}

export function readingForegroundActive(doc: Document) {
  return doc.visibilityState === "visible"
    && doc.hasFocus()
    && !doc.querySelector("[aria-modal='true']");
}
