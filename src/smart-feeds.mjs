const dayFormatters = new Map();
const dateTimeFormatters = new Map();

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

function dateTimeFormatter(timeZone) {
  if (dateTimeFormatters.has(timeZone)) return dateTimeFormatters.get(timeZone);
  const formatter = new Intl.DateTimeFormat("en-GB-u-ca-iso8601-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  dateTimeFormatters.set(timeZone, formatter);
  return formatter;
}

function zonedDateTimeParts(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Object.fromEntries(
    dateTimeFormatter(timeZone)
      .formatToParts(date)
      .map(({ type, value: partValue }) => [type, partValue]),
  );
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

export function formatZonedTime(value, timeZone) {
  const parts = zonedDateTimeParts(value, timeZone);
  if (!parts) return "--:--";
  return `${parts.hour}:${parts.minute}`;
}

export function formatZonedDateTime(value, timeZone) {
  const parts = zonedDateTimeParts(value, timeZone);
  if (!parts) return "—";
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function toZonedDateTimeInput(value, timeZone) {
  const parts = zonedDateTimeParts(value, timeZone);
  if (!parts) return "";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function zonedDateTimeInputToIso(value, timeZone, referenceValue) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new RangeError("Invalid datetime-local value");
  const [, year, month, day, hour, minute] = match;
  const target = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  let guess = target;
  const seen = new Set([guess]);
  let candidate = guess;

  for (let index = 0; index < 8; index += 1) {
    const parts = zonedDateTimeParts(guess, timeZone);
    if (!parts) throw new RangeError("Invalid datetime-local value");
    const observed = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    const next = guess + target - observed;
    if (next === guess) {
      candidate = guess;
      break;
    }
    if (seen.has(next)) {
      candidate = Math.max(guess, next);
      break;
    }
    seen.add(next);
    guess = next;
    candidate = guess;
  }

  const matchingInstants = [];
  for (let minuteOffset = -240; minuteOffset <= 240; minuteOffset += 1) {
    const instant = candidate + minuteOffset * 60_000;
    if (toZonedDateTimeInput(instant, timeZone) === value) matchingInstants.push(instant);
  }
  if (!matchingInstants.length) return new Date(candidate).toISOString();
  if (referenceValue !== undefined) {
    const reference = new Date(referenceValue).getTime();
    matchingInstants.sort((a, b) => Math.abs(a - reference) - Math.abs(b - reference));
    return new Date(matchingInstants[0]).toISOString();
  }
  return new Date(Math.min(...matchingInstants)).toISOString();
}

export function localDayKey(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
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

export function isEntryInSmartFeed(entry, mode, labels) {
  if (entry.status === "removed") return false;
  if (mode === "today") return true;
  if (mode === "updated") return labels?.get(entry.id)?.includes("updated") ?? false;
  return entry.starred;
}

export function smartFeedStatusPriority(entry, labels) {
  if (labels?.get(entry.id)?.includes("updated")) return 2;
  if (entry.status === "unread") return 1;
  return 0;
}

export function compareSmartFeedEntries(a, b, mode, labels) {
  if (mode === "today") {
    const recommendationOrder = b.score - a.score;
    if (recommendationOrder !== 0) return recommendationOrder;
  }
  const sortField = mode === "updated" ? "changed_at" : "published_at";
  const aTime = new Date(a[sortField] ?? a.published_at).getTime();
  const bTime = new Date(b[sortField] ?? b.published_at).getTime();
  return bTime - aTime || b.id - a.id;
}

export function countSmartFeedEntries(entries, labels) {
  const counts = { unreadCount: 0, todayCount: 0, updatedCount: 0, savedCount: 0 };

  for (const entry of entries) {
    if (entry.status === "removed") continue;
    if (entry.status === "unread") counts.unreadCount += 1;
    counts.todayCount += 1;
    if (labels?.get(entry.id)?.includes("updated")) counts.updatedCount += 1;
    if (entry.starred) counts.savedCount += 1;
  }

  return counts;
}
