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

test("YouTube frames load eagerly for Safari's nested article scroller", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /frame\.setAttribute\("loading", "eager"\)/);
  assert.match(app, /frame\.setAttribute\("referrerpolicy", "no-referrer"\)/);
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

test("article sanitizer preserves controlled native video playback", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /parsed\.querySelectorAll\("video"\)/);
  assert.match(app, /video\.removeAttribute\("autoplay"\)/);
  assert.match(app, /video\.setAttribute\("controls", ""\)/);
  assert.match(app, /video\.querySelectorAll\("track"\)/);
  assert.match(app, /const trackSrc = articleMediaURL/);
  assert.match(app, /parsed\.querySelectorAll\("source,track"\)/);
});

test("native videos retain their intrinsic aspect ratio", async () => {
  const css = await readFile(new URL("../src/index.css", import.meta.url), "utf8");
  assert.match(css, /\.articleContent video\{aspect-ratio:auto\}/);
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
