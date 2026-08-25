import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { articleHash, articlePermalink, parseAppRoute } from "../src/routes.ts";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

test("article hashes parse without a server-side rewrite", () => {
  assert.deepEqual(parseAppRoute(""), { kind: "list" });
  assert.deepEqual(parseAppRoute("#/"), { kind: "list" });
  assert.deepEqual(parseAppRoute("#/article/9344"), { kind: "article", entryId: 9344 });
  assert.deepEqual(parseAppRoute("#/article/9344/"), { kind: "article", entryId: 9344 });
});

test("malformed and future hashes remain unsupported routes", () => {
  for (const hash of ["#/article/0", "#/article/-1", "#/article/nope", "#/feed/12"]) {
    assert.deepEqual(parseAppRoute(hash), { kind: "unknown" });
  }
});

test("article links use a canonical GitHub Pages-safe hash", () => {
  assert.equal(articleHash(9344), "#/article/9344");
  assert.equal(
    articlePermalink("https://allanzayne.github.io/ReadFlux/#/", 9344),
    "https://allanzayne.github.io/ReadFlux/#/article/9344",
  );
  assert.throws(() => articleHash(0), RangeError);
});

test("the app synchronizes article selection with browser history", () => {
  assert.match(app, /window\.history\.pushState\(null, "", hash\)/);
  assert.match(app, /window\.addEventListener\("popstate", readRoute\)/);
  assert.match(app, /window\.addEventListener\("hashchange", readRoute\)/);
  assert.match(app, /navigateToArticle\(story\.id\)/);
  assert.match(app, /if \(mobileView === "reader"\)[\s\S]*?setMobileView\("list"\)/);
  assert.doesNotMatch(app, /choose\(routedStory, "feed"\)/);
  assert.match(app, /minifluxFetch<Entry>\(config, `\/v1\/entries\/\$\{id\}`\)/);
  assert.match(app, /<a href=\{selected\.url\} target="_blank" rel="noopener noreferrer" title=\{t\("reader\.openOriginal"\)\}/);
  assert.match(app, /clipboard\.writeText\(selected\.url\)/);
  assert.doesNotMatch(app, /clipboard\.writeText\(articlePermalink/);
});
