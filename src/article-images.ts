export function imageReferrerPolicy(useOrigin: boolean): ReferrerPolicy {
  return useOrigin ? "origin" : "no-referrer";
}

export type OriginReferrerFeeds = Record<string, number[]>;

export function updateOriginReferrerFeeds(
  current: OriginReferrerFeeds,
  scope: string,
  feedId: number,
  useOrigin: boolean,
): OriginReferrerFeeds {
  const next = new Set(current[scope] ?? []);
  if (useOrigin) next.add(feedId);
  else next.delete(feedId);
  return {
    ...current,
    [scope]: [...next].sort((a, b) => a - b),
  };
}

export async function minifluxReferrerScope(url: string) {
  const parsed = new URL(url);
  const normalized = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `miniflux:${hex}`;
}
