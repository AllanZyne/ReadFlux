const YOUTUBE_EMBED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

const YOUTUBE_VIDEO_ID = "[A-Za-z0-9_-]{11}";

export function youtubeEmbedURL(value: string): string | null {
  try {
    const candidate = value.startsWith("//") ? `https:${value}` : value;
    const url = new URL(candidate);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || !YOUTUBE_EMBED_HOSTS.has(url.hostname.toLowerCase())
      || !new RegExp(`^/embed/(?:${YOUTUBE_VIDEO_ID}|videoseries)/?$`).test(url.pathname)
    ) return null;

    url.protocol = "https:";
    return url.href;
  } catch {
    return null;
  }
}

export function articleMediaURL(value: string, baseURL?: string): string | null {
  if (!value.trim()) return null;
  try {
    const candidate = value.startsWith("//") ? `https:${value}` : value;
    const url = baseURL ? new URL(candidate, `${baseURL.replace(/\/+$/, "")}/`) : new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
