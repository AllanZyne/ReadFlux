export type ImageLoadingMode = "proxy" | "direct-no-referrer" | "direct-origin";

export type ImageLoadingPreferences = Record<string, {
  defaultMode: ImageLoadingMode;
  feedModes: Record<string, ImageLoadingMode>;
}>;

export function isImageLoadingMode(value: unknown): value is ImageLoadingMode {
  return value === "proxy" || value === "direct-no-referrer" || value === "direct-origin";
}

export function imageReferrerPolicy(mode: ImageLoadingMode): ReferrerPolicy {
  return mode === "direct-origin" ? "origin" : "no-referrer";
}

export function resolveImageLoadingMode(
  preferences: ImageLoadingPreferences,
  scope: string,
  feedId: number,
  proxyAvailable = true,
): ImageLoadingMode {
  const scoped = preferences[scope];
  const defaultMode = scoped?.defaultMode === "proxy" && !proxyAvailable
    ? "direct-no-referrer"
    : scoped?.defaultMode ?? "direct-no-referrer";
  const feedMode = scoped?.feedModes[String(feedId)];
  return feedMode === "proxy" && !proxyAvailable ? defaultMode : feedMode ?? defaultMode;
}

export function updateDefaultImageLoadingMode(
  preferences: ImageLoadingPreferences,
  scope: string,
  mode: ImageLoadingMode,
): ImageLoadingPreferences {
  return {
    ...preferences,
    [scope]: {
      defaultMode: mode,
      feedModes: { ...(preferences[scope]?.feedModes ?? {}) },
    },
  };
}

export function updateFeedImageLoadingMode(
  preferences: ImageLoadingPreferences,
  scope: string,
  feedId: number,
  mode: ImageLoadingMode | null,
): ImageLoadingPreferences {
  const scoped = preferences[scope] ?? {
    defaultMode: "direct-no-referrer" as const,
    feedModes: {},
  };
  const feedModes = { ...scoped.feedModes };
  if (mode === null) delete feedModes[String(feedId)];
  else feedModes[String(feedId)] = mode;
  return {
    ...preferences,
    [scope]: { defaultMode: scoped.defaultMode, feedModes },
  };
}

function decodeBase64URL(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  const unpadded = value.replace(/=+$/, "");
  const standard = unpadded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function originalImageURL(proxyURL: string, minifluxURL: string): string | null {
  try {
    const proxy = new URL(proxyURL);
    const miniflux = new URL(minifluxURL);
    if (proxy.origin !== miniflux.origin) return null;

    const basePath = miniflux.pathname.replace(/\/+$/, "");
    const prefix = `${basePath}/proxy/`;
    if (!proxy.pathname.startsWith(prefix)) return null;
    const segments = proxy.pathname.slice(prefix.length).split("/");
    if (segments.length !== 2 || !segments[0] || !segments[1]) return null;

    const decoded = decodeBase64URL(decodeURIComponent(segments[1]));
    if (!decoded) return null;
    const original = new URL(decoded);
    return original.protocol === "http:" || original.protocol === "https:" ? original.href : null;
  } catch {
    return null;
  }
}

export function containsMinifluxProxyURL(html: string, minifluxURL: string): boolean {
  const candidates = html.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  return candidates.some((candidate) => originalImageURL(candidate, minifluxURL) !== null);
}

export function detectMinifluxProxySupport(
  entries: Array<{ content: string }>,
  minifluxURL: string,
): boolean {
  return entries.some((entry) => containsMinifluxProxyURL(entry.content, minifluxURL));
}

export function shouldRefreshProxyContent(
  html: string,
  minifluxURL: string,
  mode: ImageLoadingMode,
  alreadyAttempted: boolean,
): boolean {
  return mode === "proxy"
    && !alreadyAttempted
    && !containsMinifluxProxyURL(html, minifluxURL);
}

export function imageURLForMode(
  imageURL: string,
  minifluxURL: string,
  mode: ImageLoadingMode,
): string {
  if (mode === "proxy") return imageURL;
  return originalImageURL(imageURL, minifluxURL) ?? imageURL;
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
