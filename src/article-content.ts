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
    url.searchParams.delete("autoplay");
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

export function isWeiboLivePhotoURL(value: string): boolean {
  try {
    const wrapper = new URL(value);
    if (
      wrapper.protocol !== "https:"
      || wrapper.hostname.toLowerCase() !== "video.weibo.com"
      || wrapper.pathname !== "/media/play"
    ) return false;

    const livePhoto = wrapper.searchParams.get("livephoto");
    if (!livePhoto) return false;
    const media = new URL(livePhoto);
    return media.protocol === "https:"
      && /(^|\.)sinaimg\.cn$/i.test(media.hostname)
      && media.pathname.toLowerCase().endsWith(".mov");
  } catch {
    return false;
  }
}
