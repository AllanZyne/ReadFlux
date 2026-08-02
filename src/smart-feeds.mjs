const dayFormatters = new Map();

function dayFormatter(timeZone) {
  if (!timeZone) return null;
  if (dayFormatters.has(timeZone)) return dayFormatters.get(timeZone);
  let formatter = null;
  try {
    formatter = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    // Invalid or unsupported zones fall back to the browser's local timezone.
  }
  dayFormatters.set(timeZone, formatter);
  return formatter;
}

export function selectTimeZone(timeZone) {
  const formatter = dayFormatter(timeZone);
  if (formatter) {
    return { timeZone: formatter.resolvedOptions().timeZone, source: "miniflux" };
  }
  return {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    source: "browser",
  };
}

export function localDayKey(value, timeZone) {
  const date = new Date(value);
  const formatter = dayFormatter(timeZone);
  if (formatter) {
    const parts = Object.fromEntries(
      formatter.formatToParts(date).map(({ type, value: partValue }) => [type, partValue]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function nextDayBoundary(value, timeZone) {
  const start = new Date(value).getTime();
  const currentDay = localDayKey(start, timeZone);
  let lowerBound = start;
  let upperBound = start + 27 * 60 * 60 * 1000;

  while (upperBound - lowerBound > 1) {
    const midpoint = Math.floor((lowerBound + upperBound) / 2);
    if (localDayKey(midpoint, timeZone) === currentDay) lowerBound = midpoint;
    else upperBound = midpoint;
  }

  return new Date(upperBound);
}

export function isEntryInSmartFeed(entry, mode, todayKey, timeZone) {
  if (mode === "today") {
    return entry.status === "unread" && localDayKey(entry.published_at, timeZone) === todayKey;
  }
  if (mode === "unread") return entry.status === "unread";
  return entry.starred;
}

export function compareSmartFeedEntries(a, b, mode) {
  return mode === "today"
    ? b.score - a.score
    : new Date(b.published_at).getTime() - new Date(a.published_at).getTime();
}

export function countSmartFeedEntries(entries, todayKey, timeZone) {
  const counts = { unreadCount: 0, todayUnreadCount: 0, savedCount: 0 };

  for (const entry of entries) {
    if (entry.status === "unread") {
      counts.unreadCount += 1;
      if (localDayKey(entry.published_at, timeZone) === todayKey) counts.todayUnreadCount += 1;
    }
    if (entry.starred) counts.savedCount += 1;
  }

  return counts;
}
