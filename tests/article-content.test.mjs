import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const articleContent = await import("../src/article-content.ts").catch(() => ({}));

test("YouTube video and privacy-enhanced embed URLs are accepted", () => {
  assert.equal(typeof articleContent.youtubeEmbedURL, "function");
  assert.equal(
    articleContent.youtubeEmbedURL("https://www.youtube.com/embed/dQw4w9WgXcQ?si=abc"),
    "https://www.youtube.com/embed/dQw4w9WgXcQ?si=abc",
  );
  assert.equal(
    articleContent.youtubeEmbedURL("//www.youtube-nocookie.com/embed/dQw4w9WgXcQ"),
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  );
  assert.equal(
    articleContent.youtubeEmbedURL("https://www.youtube.com/embed/videoseries?list=PL123"),
    "https://www.youtube.com/embed/videoseries?list=PL123",
  );
});

test("non-YouTube, non-embed, and unsafe iframe URLs are rejected", () => {
  assert.equal(articleContent.youtubeEmbedURL("https://youtube.example/embed/dQw4w9WgXcQ"), null);
  assert.equal(articleContent.youtubeEmbedURL("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(articleContent.youtubeEmbedURL("https://www.youtube.com/embed/too-short"), null);
  assert.equal(articleContent.youtubeEmbedURL("http://www.youtube.com/embed/dQw4w9WgXcQ"), null);
  assert.equal(articleContent.youtubeEmbedURL("javascript:alert(1)"), null);
});

test("YouTube embeds cannot request autoplay", () => {
  assert.equal(
    articleContent.youtubeEmbedURL("https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&si=abc"),
    "https://www.youtube.com/embed/dQw4w9WgXcQ?si=abc",
  );
});

test("YouTube frames load eagerly and use the selected media referrer policy", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /frame\.setAttribute\("loading", "eager"\)/);
  assert.match(app, /frame\.setAttribute\("referrerpolicy", imageReferrerPolicy\(imageMode\)\)/);
  assert.doesNotMatch(app, /frame\.setAttribute\("allow", "[^"]*autoplay/);
});

test("native article media accepts HTTP(S) sources and rejects unsafe protocols", () => {
  assert.equal(
    articleContent.articleMediaURL("https://video.twimg.com/media/video.mp4?tag=29"),
    "https://video.twimg.com/media/video.mp4?tag=29",
  );
  assert.equal(
    articleContent.articleMediaURL("/proxy/poster", "https://reader.example/miniflux"),
    "https://reader.example/proxy/poster",
  );
  assert.equal(articleContent.articleMediaURL("javascript:alert(1)"), null);
  assert.equal(articleContent.articleMediaURL("data:video/mp4;base64,AAAA"), null);
  assert.equal(articleContent.articleMediaURL("blob:https://x.com/id"), null);
  assert.equal(articleContent.articleMediaURL("", "https://reader.example/miniflux"), null);
  assert.equal(articleContent.articleMediaURL("   ", "https://reader.example/miniflux"), null);
});

test("expired signed Weibo media URLs are rejected without affecting other media", () => {
  const expired = "https://f.video.weibocdn.com/path/video.mp4?Expires=1786457601&ssig=old";
  const active = "https://f.video.weibocdn.com/path/video.mp4?Expires=1786547601&ssig=current";
  const now = 1_786_540_575_000;

  assert.equal(articleContent.isExpiredWeiboMediaURL(expired, now), true);
  assert.equal(articleContent.isExpiredWeiboMediaURL(active, now), false);
  assert.equal(articleContent.isExpiredWeiboMediaURL("https://video.example/video.mp4?Expires=1", now), false);
  assert.equal(articleContent.isExpiredWeiboMediaURL("not a URL", now), false);
});

test("article sanitizer preserves controlled native video playback", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /parsed\.querySelectorAll\("video"\)/);
  assert.match(app, /video\.removeAttribute\("autoplay"\)/);
  assert.match(app, /video\.setAttribute\("controls", ""\)/);
  assert.match(app, /video\.querySelectorAll\("track"\)/);
  assert.match(app, /const trackSrc = articleMediaURL/);
  assert.match(app, /video\.setAttribute\("referrerpolicy", imageReferrerPolicy\(imageMode\)\)/);
  assert.match(app, /parsed\.querySelectorAll\("source,track"\)/);
  assert.match(app, /isExpiredWeiboMediaURL\(sourceSrc\)/);
  assert.match(app, /video\.replaceWith\(\.\.\.fallbackNodes\)/);
});

test("native videos retain their intrinsic aspect ratio", async () => {
  const css = await readFile(new URL("../src/index.css", import.meta.url), "utf8");
  assert.match(css, /\.articleContent video\{aspect-ratio:auto\}/);
});

test("the first article paragraph uses the normal paragraph style", async () => {
  const css = await readFile(new URL("../src/index.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.body\s*>\s*p:first-child/);
});

test("native media requests do not leak a referrer rejected by media CDNs", async () => {
  const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(page, /<meta name="referrer" content="no-referrer" \/>/);
});

test("linked text icons stay inline without changing linked article images", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/index.css", import.meta.url), "utf8");
  assert.match(app, /parentLink\?\.children\.length === 1 && parentLink\.textContent\?\.trim\(\)/);
  assert.match(app, /image\.classList\.add\("articleInlineIcon"\)/);
  assert.match(css, /\.articleContent img\.articleInlineIcon\{display:inline-block;/);
});

test("proxy image failures fall back to the original image URL", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /const originalSrc = imageMode === "proxy"\s*\?\s*originalImageURL\(currentSrc, minifluxURL\)\s*:\s*null/);
  assert.match(app, /data-readflux-original-src/);
  assert.match(app, /handleArticleImageError/);
  assert.match(app, /image\.src = originalSrc/);
});

test("Weibo Live Photo wrappers are distinguished from ordinary videos", () => {
  const livePhoto = "https://video.weibo.com/media/play?livephoto=https%3A%2F%2Flivephoto.us.sinaimg.cn%2Fexample.mov";
  assert.equal(articleContent.isWeiboLivePhotoURL(livePhoto), true);
  assert.equal(articleContent.isWeiboLivePhotoURL("https://video.weibo.com/media/play?id=123"), false);
  assert.equal(articleContent.isWeiboLivePhotoURL("https://video.example/media/play?livephoto=https%3A%2F%2Flivephoto.us.sinaimg.cn%2Fexample.mov"), false);
  assert.equal(articleContent.isWeiboLivePhotoURL("https://video.weibo.com/media/play?livephoto=javascript%3Aalert(1)"), false);
});

test("Live Photos use an accessible click-to-loop presentation", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/index.css", import.meta.url), "utf8");
  assert.match(app, /video\.classList\.add\("articleLivePhoto"\)/);
  assert.match(app, /frame\.setAttribute\("role", "button"\)/);
  assert.match(app, /toggleLivePhoto\(event\.target\)/);
  assert.match(app, /posterImage\.setAttribute\("referrerpolicy", "origin"\)/);
  assert.match(css, /\.articleLivePhotoBadge\{/);
  assert.match(css, /\.articleLivePhotoFrame\.playing \.articleLivePhotoPoster\{opacity:0\}/);
});
