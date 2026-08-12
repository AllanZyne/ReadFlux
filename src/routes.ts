export type AppRoute =
  | { kind: "list" }
  | { kind: "article"; entryId: number }
  | { kind: "unknown" };

export function parseAppRoute(hash: string): AppRoute {
  if (!hash || hash === "#" || hash === "#/") return { kind: "list" };
  const match = /^#\/article\/([1-9]\d*)\/?$/.exec(hash);
  if (!match) return { kind: "unknown" };
  const entryId = Number(match[1]);
  return Number.isSafeInteger(entryId)
    ? { kind: "article", entryId }
    : { kind: "unknown" };
}

export function articleHash(entryId: number) {
  if (!Number.isSafeInteger(entryId) || entryId <= 0) throw new RangeError("Invalid entry ID");
  return `#/article/${entryId}`;
}

export function articlePermalink(pageURL: string, entryId: number) {
  const url = new URL(pageURL);
  url.hash = articleHash(entryId).slice(1);
  return url.href;
}
