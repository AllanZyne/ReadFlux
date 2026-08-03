export type SmartFeedMode = "today" | "unread" | "saved";

export type SmartFeedEntry = {
  status: "read" | "unread" | "removed";
  starred: boolean;
  published_at: string;
};

export type SortableSmartFeedEntry = SmartFeedEntry & { score: number };

export type SmartFeedCounts = {
  unreadCount: number;
  todayCount: number;
  savedCount: number;
};

export type TimeZoneSelection = {
  timeZone: string;
  source: "miniflux" | "browser";
};

export function selectTimeZone(timeZone?: string): TimeZoneSelection;
export function formatZonedTime(value: string | number | Date, timeZone: string): string;
export function formatZonedDateTime(value: string | number | Date, timeZone: string): string;
export function toZonedDateTimeInput(value: string | number | Date, timeZone: string): string;
export function zonedDateTimeInputToIso(
  value: string,
  timeZone: string,
  referenceValue?: string | number | Date,
): string;
export function localDayKey(value: string | number | Date, timeZone?: string): string;
export function nextDayBoundary(value: string | number | Date, timeZone?: string): Date;
export function isEntryInSmartFeed(
  entry: SmartFeedEntry,
  mode: SmartFeedMode,
  todayKey: string,
  timeZone?: string,
): boolean;
export function compareSmartFeedEntries(
  a: SortableSmartFeedEntry,
  b: SortableSmartFeedEntry,
  mode: SmartFeedMode,
): number;
export function countSmartFeedEntries(
  entries: SmartFeedEntry[],
  todayKey: string,
  timeZone?: string,
): SmartFeedCounts;
