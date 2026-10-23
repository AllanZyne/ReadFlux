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

type AttentionInput = {
  type: string;
  clientX: number;
  clientY: number;
  target: EventTarget | null;
  /** Absent on wheel events, which come from a mouse or trackpad. */
  pointerType?: string;
  relatedTarget?: EventTarget | null;
};

/**
 * Decides reader attention from mouse position: the mouse must rest on the
 * reader or the open article's list card. Touch has no hover, so only a tap
 * moves attention, and keyboard resumption holds until the mouse next acts. A
 * fullscreen article video holds attention wherever the pointer is.
 */
export function createReadingAttentionTracker(env: {
  attention: () => boolean;
  setAttention: (attending: boolean) => void;
  fullscreenElement: () => Element | null;
  elementFromPoint: (x: number, y: number) => Element | null;
  isFrame: (target: EventTarget | null) => boolean;
}) {
  // The last mouse position while the mouse, not keys or touch, decides attention.
  let mouse: { x: number; y: number } | null = null;
  // While an article video is fullscreen: the attention to restore on exit when
  // no mouse position is known. Null outside fullscreen.
  let beforeFullscreen: boolean | null = null;
  const fullscreenReading = () => isReadingPointerTarget(env.fullscreenElement());
  const underMouse = () => mouse && isReadingPointerTarget(env.elementFromPoint(mouse.x, mouse.y));
  return {
    /** pointermove, pointerdown, and wheel. */
    pointer(event: AttentionInput) {
      const fromMouse = event.pointerType === undefined || event.pointerType === "mouse";
      if (event.type === "pointermove" && !fromMouse) return;
      mouse = fromMouse ? { x: event.clientX, y: event.clientY } : null;
      env.setAttention(fullscreenReading() || isReadingPointerTarget(event.target));
    },
    /** pointerout: only leaving the window counts; moving into an embedded video frame does not. */
    out(event: AttentionInput) {
      if (event.pointerType !== "mouse" || event.relatedTarget || env.isFrame(event.target)) return;
      mouse = null;
      if (beforeFullscreen !== null) beforeFullscreen = false;
      else env.setAttention(false);
    },
    key() {
      mouse = null;
    },
    /** Scrolling can move the open article's card out from under a resting mouse. */
    scroll() {
      if (mouse && beforeFullscreen === null) env.setAttention(!!underMouse());
    },
    fullscreenChange() {
      if (fullscreenReading()) {
        if (beforeFullscreen === null) beforeFullscreen = env.attention();
        env.setAttention(true);
      } else if (beforeFullscreen !== null) {
        const restored = mouse ? !!underMouse() : beforeFullscreen;
        beforeFullscreen = null;
        env.setAttention(restored);
      }
    },
  };
}

export function readingForegroundActive(doc: Document) {
  return doc.visibilityState === "visible"
    && doc.hasFocus()
    && !doc.querySelector("[aria-modal='true']");
}
