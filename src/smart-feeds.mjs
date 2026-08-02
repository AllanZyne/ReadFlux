export function localDayKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
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
