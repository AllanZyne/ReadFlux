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

test("YouTube frames load eagerly for Safari's nested article scroller", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /frame\.setAttribute\("loading", "eager"\)/);
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
