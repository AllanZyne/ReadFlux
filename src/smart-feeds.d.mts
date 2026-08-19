export type SmartFeedMode = "today" | "all" | "updated" | "saved";

export type SmartFeedEntry = {
  id: number;
  status: "read" | "unread" | "removed";
  starred: boolean;
  published_at: string;
  changed_at?: string;
};

export type SortableSmartFeedEntry = SmartFeedEntry & { score: number };

export type SmartFeedCounts = {
  unreadCount: number;
  todayCount: number;
  allCount: number;
  updatedCount: number;
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
export function smartFeedTimeBucket(
  value: string | number | Date,
  now?: string | number | Date,
  timeZone?: string,
): 0 | 1 | 2 | 3 | 4 | 5;
export function isEntryInSmartFeed(
  entry: SmartFeedEntry,
  mode: SmartFeedMode,
  labels?: Map<number, string[]>,
): boolean;
export function compareSmartFeedEntries(
  a: SortableSmartFeedEntry & { id: number },
  b: SortableSmartFeedEntry & { id: number },
  mode: SmartFeedMode,
  labels?: Map<number, string[]>,
  context?: {
    now?: string | number | Date;
    timeZone?: string;
  },
): number;
export function smartFeedStatusPriority(
  entry: { id: number; status: "read" | "unread" | "removed" },
  labels?: Map<number, string[]>,
): number;
export function countSmartFeedEntries(
  entries: SmartFeedEntry[],
  labels?: Map<number, string[]>,
): SmartFeedCounts;
