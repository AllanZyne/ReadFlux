import assert from "node:assert/strict";
import test from "node:test";

const imagePolicyModule = await import("../src/article-images.ts").catch(() => ({}));

test("article image modes choose the expected referrer policy", () => {
  assert.equal(typeof imagePolicyModule.imageReferrerPolicy, "function");
  assert.equal(imagePolicyModule.imageReferrerPolicy("proxy"), "no-referrer");
  assert.equal(imagePolicyModule.imageReferrerPolicy("direct-no-referrer"), "no-referrer");
  assert.equal(imagePolicyModule.imageReferrerPolicy("direct-origin"), "origin");
});

test("feed image modes override their Miniflux-scoped default", () => {
  assert.equal(typeof imagePolicyModule.resolveImageLoadingMode, "function");
  const preferences = {
    "server-a": {
      defaultMode: "direct-no-referrer",
      feedModes: { 7: "proxy", 9: "direct-origin" },
    },
    "server-b": {
      defaultMode: "proxy",
      feedModes: {},
    },
  };
  assert.equal(imagePolicyModule.resolveImageLoadingMode(preferences, "server-a", 7), "proxy");
  assert.equal(imagePolicyModule.resolveImageLoadingMode(preferences, "server-a", 9), "direct-origin");
  assert.equal(imagePolicyModule.resolveImageLoadingMode(preferences, "server-a", 11), "direct-no-referrer");
  assert.equal(imagePolicyModule.resolveImageLoadingMode(preferences, "server-b", 7), "proxy");
  assert.equal(imagePolicyModule.resolveImageLoadingMode({}, "unknown", 7), "direct-no-referrer");
  assert.equal(imagePolicyModule.resolveImageLoadingMode(preferences, "server-a", 7, false), "direct-no-referrer");
  assert.equal(imagePolicyModule.resolveImageLoadingMode(preferences, "server-a", 9, false), "direct-origin");
});

test("image preference updates are scoped and immutable", () => {
  assert.equal(typeof imagePolicyModule.updateDefaultImageLoadingMode, "function");
  assert.equal(typeof imagePolicyModule.updateFeedImageLoadingMode, "function");
  const current = {
    "server-a": {
      defaultMode: "direct-no-referrer",
      feedModes: { 7: "proxy" },
    },
  };
  const withDefault = imagePolicyModule.updateDefaultImageLoadingMode(
    current,
    "server-a",
    "direct-origin",
  );
  const withOverride = imagePolicyModule.updateFeedImageLoadingMode(
    withDefault,
    "server-a",
    9,
    "proxy",
  );
  const inherited = imagePolicyModule.updateFeedImageLoadingMode(
    withOverride,
    "server-a",
    7,
    null,
  );
  assert.equal(current["server-a"].defaultMode, "direct-no-referrer");
  assert.deepEqual(inherited["server-a"], {
    defaultMode: "direct-origin",
    feedModes: { 9: "proxy" },
  });
});

test("built-in Miniflux proxy URLs can be restored to their original URL", () => {
  assert.equal(typeof imagePolicyModule.originalImageURL, "function");
  const original = "https://images.example/photo.jpg?size=large&x=1";
  const encoded = Buffer.from(original).toString("base64url");
  const proxy = `https://reader.example/miniflux/proxy/signed-digest/${encoded}`;
  assert.equal(
    imagePolicyModule.originalImageURL(proxy, "https://reader.example/miniflux/"),
    original,
  );
});

test("proxy capability is detected only from decodable links for that Miniflux server", () => {
  assert.equal(typeof imagePolicyModule.containsMinifluxProxyURL, "function");
  const original = "https://images.example/photo.jpg";
  const encoded = Buffer.from(original).toString("base64url");
  const matching = `<p><img src="https://reader.example/app/proxy/digest/${encoded}"></p>`;
  const unrelated = `<img src="https://other.example/app/proxy/digest/${encoded}">`;
  assert.equal(imagePolicyModule.containsMinifluxProxyURL(matching, "https://reader.example/app"), true);
  assert.equal(imagePolicyModule.containsMinifluxProxyURL(unrelated, "https://reader.example/app"), false);
  assert.equal(imagePolicyModule.containsMinifluxProxyURL("<img src='https://images.example/photo.jpg'>", "https://reader.example/app"), false);
});

test("a current proxy probe can authoritatively clear stale cached capability", () => {
  assert.equal(typeof imagePolicyModule.detectMinifluxProxySupport, "function");
  const original = "https://images.example/photo.jpg";
  const encoded = Buffer.from(original).toString("base64url");
  const cached = [{ content: `<img src="https://reader.example/proxy/digest/${encoded}">` }];
  const currentProbe = [{ content: "<img src=\"https://images.example/current.jpg\">" }];
  assert.equal(imagePolicyModule.detectMinifluxProxySupport(cached, "https://reader.example"), true);
  assert.equal(imagePolicyModule.detectMinifluxProxySupport(currentProbe, "https://reader.example"), false);
});

test("old content refreshes once when proxy mode becomes effective", () => {
  assert.equal(typeof imagePolicyModule.shouldRefreshProxyContent, "function");
  const server = "https://reader.example";
  const direct = "<img src=\"https://images.example/photo.jpg\">";
  const encoded = Buffer.from("https://images.example/photo.jpg").toString("base64url");
  const proxied = `<img src="${server}/proxy/digest/${encoded}">`;
  assert.equal(imagePolicyModule.shouldRefreshProxyContent(direct, server, "direct-no-referrer", false), false);
  assert.equal(imagePolicyModule.shouldRefreshProxyContent(direct, server, "proxy", false), true);
  assert.equal(imagePolicyModule.shouldRefreshProxyContent(direct, server, "proxy", true), false);
  assert.equal(imagePolicyModule.shouldRefreshProxyContent(proxied, server, "proxy", false), false);
});

test("proxy URL restoration rejects unrelated, malformed, and unsafe URLs", () => {
  assert.equal(imagePolicyModule.originalImageURL(
    "https://other.example/miniflux/proxy/digest/aHR0cHM6Ly9leGFtcGxlLmNvbQ",
    "https://reader.example/miniflux",
  ), null);
  assert.equal(imagePolicyModule.originalImageURL(
    "https://reader.example/miniflux/proxy/digest/not-base64!",
    "https://reader.example/miniflux",
  ), null);
  assert.equal(imagePolicyModule.originalImageURL(
    `https://reader.example/miniflux/proxy/digest/${Buffer.from("javascript:alert(1)").toString("base64url")}`,
    "https://reader.example/miniflux",
  ), null);
});

test("direct modes restore originals while proxy mode preserves the proxy URL", () => {
  assert.equal(typeof imagePolicyModule.imageURLForMode, "function");
  const original = "https://images.example/photo.jpg";
  const proxy = `https://reader.example/proxy/digest/${Buffer.from(original).toString("base64url")}`;
  assert.equal(imagePolicyModule.imageURLForMode(proxy, "https://reader.example", "proxy"), proxy);
  assert.equal(imagePolicyModule.imageURLForMode(proxy, "https://reader.example", "direct-no-referrer"), original);
  assert.equal(imagePolicyModule.imageURLForMode(proxy, "https://reader.example", "direct-origin"), original);
  assert.equal(imagePolicyModule.imageURLForMode(original, "https://reader.example", "direct-origin"), original);
});

test("equivalent Miniflux URLs have the same non-plain-text scope", async () => {
  assert.equal(typeof imagePolicyModule.minifluxReferrerScope, "function");
  const first = await imagePolicyModule.minifluxReferrerScope("https://MINIFLUX.example/app/");
  const equivalent = await imagePolicyModule.minifluxReferrerScope("https://miniflux.example/app");
  const other = await imagePolicyModule.minifluxReferrerScope("https://other.example/app");
  assert.equal(first, equivalent);
  assert.notEqual(first, other);
  assert.equal(first.includes("miniflux.example"), false);
});
