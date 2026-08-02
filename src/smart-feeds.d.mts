export type SmartFeedMode = "today" | "unread" | "saved";

export type SmartFeedEntry = {
  status: "read" | "unread" | "removed";
  starred: boolean;
  published_at: string;
};

export type SortableSmartFeedEntry = SmartFeedEntry & { score: number };

export type SmartFeedCounts = {
  unreadCount: number;
  todayUnreadCount: number;
  savedCount: number;
};

export function localDayKey(value: string | number | Date): string;
export function isEntryInSmartFeed(
  entry: SmartFeedEntry,
  mode: SmartFeedMode,
  todayKey: string,
): boolean;
export function compareSmartFeedEntries(
  a: SortableSmartFeedEntry,
  b: SortableSmartFeedEntry,
  mode: SmartFeedMode,
): number;
export function countSmartFeedEntries(
  entries: SmartFeedEntry[],
  todayKey: string,
): SmartFeedCounts;
