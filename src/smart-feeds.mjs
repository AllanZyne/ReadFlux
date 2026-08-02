export function localDayKey(value) {
  const date = new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function isEntryInSmartFeed(entry, mode, todayKey) {
  if (mode === "today") {
    return entry.status === "unread" && localDayKey(entry.published_at) === todayKey;
  }
  if (mode === "unread") return entry.status === "unread";
  return entry.starred;
}

export function compareSmartFeedEntries(a, b, mode) {
  return mode === "today"
    ? b.score - a.score
    : new Date(b.published_at).getTime() - new Date(a.published_at).getTime();
}

export function countSmartFeedEntries(entries, todayKey) {
  const counts = { unreadCount: 0, todayUnreadCount: 0, savedCount: 0 };

  for (const entry of entries) {
    if (entry.status === "unread") {
      counts.unreadCount += 1;
      if (localDayKey(entry.published_at) === todayKey) counts.todayUnreadCount += 1;
    }
    if (entry.starred) counts.savedCount += 1;
  }

  return counts;
}
