import assert from "node:assert/strict";
import test from "node:test";

const imagePolicyModule = await import("../src/article-images.ts").catch(() => ({}));

test("article images hide the referrer unless their feed opts into origin", () => {
  assert.equal(typeof imagePolicyModule.imageReferrerPolicy, "function");
  assert.equal(imagePolicyModule.imageReferrerPolicy(false), "no-referrer");
  assert.equal(imagePolicyModule.imageReferrerPolicy(true), "origin");
});

test("origin feed selections are scoped to a Miniflux instance", () => {
  assert.equal(typeof imagePolicyModule.updateOriginReferrerFeeds, "function");
  const current = {
    "server-a": [7, 3],
    "server-b": [7],
  };
  const added = imagePolicyModule.updateOriginReferrerFeeds(
    current,
    "server-a",
    5,
    true,
  );
  assert.deepEqual(added["server-a"], [3, 5, 7]);
  assert.deepEqual(added["server-b"], current["server-b"]);
  assert.deepEqual(current["server-a"], [7, 3]);
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
