import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  articleLinkHref,
  ensureReadLaterFeed,
  fallbackReadLaterTitle,
  importReadLaterEntry,
  isReadLaterFeedURL,
  minifluxVersionAtLeast,
  READ_LATER_CATEGORY_TITLE,
  READ_LATER_FEED_FILE,
  ReadLaterError,
  readLaterFeedFileURL,
  readLaterFeedIds,
  readLaterLinkTitle,
  readLaterLinkURL,
  readLaterSourceFromTags,
  readLaterSourceTag,
  saveReadLaterLink,
} from "../src/read-later.ts";

const FEED_URL = "https://reader.example/ReadFlux/readflux-read-later.xml";

/** A Miniflux stand-in that records requests and answers like the real API. */
function fakeMiniflux({ version = "2.3.3", feeds = [], categories = [{ id: 1, title: "News" }], createFeed, importEntry } = {}) {
  const requests = [];
  const state = { feeds: [...feeds], categories: [...categories], nextId: 100 };
  const failure = (status, detail) => Object.assign(new Error(`Miniflux request failed (${status})`), { status, detail });
  const fetchJson = async (path, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method, path, body });
    if (path === "/v1/version") return { version };
    if (path === "/v1/feeds" && method === "GET") return state.feeds;
    if (path === "/v1/categories" && method === "GET") return state.categories;
    if (path === "/v1/categories" && method === "POST") {
      const category = { id: state.nextId++, title: body.title };
      state.categories.push(category);
      return category;
    }
    if (path === "/v1/feeds" && method === "POST") {
      if (createFeed) return createFeed(body, state);
      const feed = { id: state.nextId++, feed_url: body.feed_url, category: { id: body.category_id } };
      state.feeds.push(feed);
      return { feed_id: feed.id };
    }
    const importMatch = /^\/v1\/feeds\/(\d+)\/entries\/import$/.exec(path);
    if (importMatch) {
      if (!state.feeds.some((feed) => feed.id === Number(importMatch[1]))) throw failure(400, "feed does not exist");
      if (importEntry) return importEntry(body, failure);
      return { id: 500 };
    }
    if (/^\/v1\/entries\/\d+\/fetch-content/.test(path)) return { content: "<p>Body</p>" };
    throw failure(404);
  };
  return { fetchJson, requests, state };
}

test("the Read later feed is recognized by its file name on any deployment", () => {
  assert.equal(readLaterFeedFileURL("https://allanzyne.github.io/ReadFlux/#/article/7"), "https://allanzyne.github.io/ReadFlux/readflux-read-later.xml");
  assert.equal(readLaterFeedFileURL("http://localhost:5173/"), `http://localhost:5173/${READ_LATER_FEED_FILE}`);
  assert.equal(isReadLaterFeedURL("https://fork.example/reader/readflux-read-later.xml"), true);
  assert.equal(isReadLaterFeedURL("https://example.com/read-later.xml"), false);
  assert.equal(isReadLaterFeedURL("https://example.com/feed.xml?file=readflux-read-later.xml"), false);
  assert.equal(isReadLaterFeedURL(undefined), false);
  assert.equal(isReadLaterFeedURL("not a url"), false);
  assert.deepEqual([...readLaterFeedIds([
    { id: 3, feed_url: "https://example.com/rss" },
    { id: 8, feed_url: FEED_URL },
    { id: 9 },
  ])], [8]);
});

test("link actions keep the fragment, which can name a section or a route", () => {
  assert.equal(articleLinkHref("https://example.com/guide#installation"), "https://example.com/guide#installation");
  assert.equal(articleLinkHref("https://example.com/#/articles/42"), "https://example.com/#/articles/42");
  assert.equal(articleLinkHref("/notes/1#top", "https://blog.example/2026/post"), "https://blog.example/notes/1#top");
  assert.equal(articleLinkHref("#section", "https://example.com/post"), null);
  assert.equal(articleLinkHref("mailto:me@example.com"), null);
  // Matching synced entries ignores the fragment.
  assert.equal(readLaterLinkURL(articleLinkHref("https://example.com/#/articles/42")), "https://example.com/");

  return readFile(new URL("../src/App.tsx", import.meta.url), "utf8").then((app) => {
    assert.match(app, /const url = articleLinkHref\(anchor\.getAttribute\("href"\), articleURL\);\s*const matchURL = readLaterLinkURL\(url\);/);
    assert.match(app, /readLaterLinkURL\(entry\.url\) !== link\.matchURL/);
    assert.match(app, /window\.open\(menu\.url, "_blank", "noopener,noreferrer"\)/);
    assert.match(app, /navigator\.clipboard\.writeText\(menu\.url\)/);
  });
});

test("the link menu stays on screen in short viewports", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/index.css", import.meta.url), "utf8");
  assert.match(app, /const maxHeight = window\.innerHeight - margin \* 2;/);
  assert.match(app, /const top = fitsBelow \? below : fitsAbove \? above : Math\.max\(margin, Math\.min\(window\.innerHeight - margin - height, below\)\);/);
  assert.match(app, /maxHeight: linkMenu\.maxHeight/);
  // Scrolling inside the menu must not dismiss it.
  assert.match(app, /if \(event\.target instanceof Node && linkMenuRef\.current\?\.contains\(event\.target\)\) return;/);
  assert.match(styles, /\.linkMenu\.detached\{overflow-y:auto;/);
  assert.match(styles, /\.linkMenu\.detached:before\{display:none\}/);
});

test("article links resolve against the article and drop their fragment", () => {
  assert.equal(readLaterLinkURL("https://example.com/post#comments"), "https://example.com/post");
  assert.equal(readLaterLinkURL("/notes/1", "https://blog.example/2026/post"), "https://blog.example/notes/1");
  assert.equal(readLaterLinkURL("  https://example.com/a  ", ""), "https://example.com/a");
  assert.equal(readLaterLinkURL("#section", "https://example.com/post"), null);
  assert.equal(readLaterLinkURL("mailto:me@example.com", "https://example.com/post"), null);
  assert.equal(readLaterLinkURL("javascript:void(0)", "https://example.com/post"), null);
  assert.equal(readLaterLinkURL("relative/path", ""), null);
  assert.equal(readLaterLinkURL("", "https://example.com"), null);
});

test("link text names the saved page unless it only describes the link", () => {
  const url = "https://www.paulgraham.com/greatwork.html";
  assert.equal(readLaterLinkTitle({ text: "  How to Do\n Great Work " }, url), "How to Do Great Work");
  assert.equal(readLaterLinkTitle({ text: "阅读原文", title: "How to Do Great Work" }, url), "How to Do Great Work");
  assert.equal(readLaterLinkTitle({ text: "Read more →" }, url), "paulgraham.com · greatwork");
  assert.equal(readLaterLinkTitle({ text: "here", title: "", imageAlt: "Cover of the essay" }, url), "Cover of the essay");
  assert.equal(readLaterLinkTitle({ text: url }, url), "paulgraham.com · greatwork");
  assert.equal(readLaterLinkTitle({ text: "paulgraham.com/greatwork.html" }, url), "paulgraham.com · greatwork");
  assert.equal(readLaterLinkTitle({ text: "x" }, url), "paulgraham.com · greatwork");
  assert.equal(readLaterLinkTitle({ text: "« lire la suite »" }, url), "paulgraham.com · greatwork");
  assert.equal([...readLaterLinkTitle({ text: "长".repeat(300) }, url)].length, 200);
});

test("fallback titles use the host and a readable last path segment", () => {
  assert.equal(fallbackReadLaterTitle("https://www.example.com/"), "example.com");
  assert.equal(fallbackReadLaterTitle("https://example.com/blog/my-first_post.html"), "example.com · my first post");
  assert.equal(fallbackReadLaterTitle("https://example.com/%E6%96%87%E7%AB%A0"), "example.com · 文章");
  assert.equal(fallbackReadLaterTitle("https://example.com/bad%E0%A4%A"), "example.com · bad%E0%A4%A");
});

test("entry import needs Miniflux 2.2.16", () => {
  assert.equal(minifluxVersionAtLeast("2.3.3", "2.2.16"), true);
  assert.equal(minifluxVersionAtLeast("2.2.16", "2.2.16"), true);
  assert.equal(minifluxVersionAtLeast("2.2.15", "2.2.16"), false);
  assert.equal(minifluxVersionAtLeast("2.1.20", "2.2.16"), false);
  assert.equal(minifluxVersionAtLeast("v3.0", "2.2.16"), true);
  assert.equal(minifluxVersionAtLeast("Development", "2.2.16"), true);
  assert.equal(minifluxVersionAtLeast(undefined, "2.2.16"), true);
});

test("the first saved link creates a disabled feed in its own category", async () => {
  const miniflux = fakeMiniflux();
  const result = await saveReadLaterLink(miniflux.fetchJson, {
    feedURL: FEED_URL,
    link: { url: "https://example.com/post", title: "A post" },
  });

  assert.deepEqual(result, { entryId: 500, feedId: 101, feedResolved: true });
  const category = miniflux.requests.find((request) => request.method === "POST" && request.path === "/v1/categories");
  assert.deepEqual(category.body, { title: READ_LATER_CATEGORY_TITLE });
  const feed = miniflux.requests.find((request) => request.method === "POST" && request.path === "/v1/feeds");
  assert.deepEqual(feed.body, { feed_url: FEED_URL, category_id: 100, disabled: true });
  const imported = miniflux.requests.find((request) => request.path === "/v1/feeds/101/entries/import");
  // Miniflux imports entries as read unless asked otherwise.
  assert.deepEqual(imported.body, { url: "https://example.com/post", title: "A post", status: "unread" });
  assert.ok(miniflux.requests.some((request) => request.path === "/v1/entries/500/fetch-content?update_content=true"));
});

test("an existing Read later feed and category are reused", async () => {
  const miniflux = fakeMiniflux({
    feeds: [{ id: 7, feed_url: "https://other.example/readflux-read-later.xml" }],
  });
  assert.deepEqual(await ensureReadLaterFeed(miniflux.fetchJson, FEED_URL), { feedId: 7, created: false });
  assert.ok(!miniflux.requests.some((request) => request.method === "POST"));

  const withCategory = fakeMiniflux({ categories: [{ id: 4, title: READ_LATER_CATEGORY_TITLE }] });
  await ensureReadLaterFeed(withCategory.fetchJson, FEED_URL);
  assert.ok(!withCategory.requests.some((request) => request.method === "POST" && request.path === "/v1/categories"));
  assert.equal(withCategory.requests.find((request) => request.path === "/v1/feeds" && request.method === "POST").body.category_id, 4);
});

test("a known feed skips the lookup, and a feed deleted in Miniflux is recreated once", async () => {
  const known = fakeMiniflux({ feeds: [{ id: 7, feed_url: FEED_URL }] });
  assert.deepEqual(
    await saveReadLaterLink(known.fetchJson, { feedId: 7, feedURL: FEED_URL, link: { url: "https://example.com/a", title: "A" } }),
    { entryId: 500, feedId: 7, feedResolved: false },
  );
  assert.ok(!known.requests.some((request) => request.path === "/v1/feeds" || request.path === "/v1/version"));

  const deleted = fakeMiniflux();
  const result = await saveReadLaterLink(deleted.fetchJson, { feedId: 7, feedURL: FEED_URL, link: { url: "https://example.com/a", title: "A" } });
  assert.equal(result.feedResolved, true);
  assert.notEqual(result.feedId, 7);
});

test("old Miniflux servers and unreachable feed files raise Read later errors", async () => {
  await assert.rejects(
    ensureReadLaterFeed(fakeMiniflux({ version: "2.2.10" }).fetchJson, FEED_URL),
    (error) => error instanceof ReadLaterError && error.kind === "unsupported" && error.version === "2.2.10",
  );
  const unreachable = fakeMiniflux({
    createFeed: () => { throw Object.assign(new Error("failed"), { status: 500 }); },
  });
  await assert.rejects(
    ensureReadLaterFeed(unreachable.fetchJson, "http://localhost:5173/readflux-read-later.xml"),
    (error) => error instanceof ReadLaterError && error.kind === "feed-unavailable"
      && error.feedURL === "http://localhost:5173/readflux-read-later.xml",
  );
  // Another device creating the feed at the same moment is not an error.
  const raced = fakeMiniflux({
    createFeed: (_body, state) => {
      state.feeds.push({ id: 42, feed_url: FEED_URL });
      throw Object.assign(new Error("duplicated"), { status: 500 });
    },
  });
  assert.deepEqual(await ensureReadLaterFeed(raced.fetchJson, FEED_URL), { feedId: 42, created: true });
});

test("a link Miniflux cleaned up before imports again under a new external ID", async () => {
  const miniflux = fakeMiniflux({
    feeds: [{ id: 7, feed_url: FEED_URL }],
    importEntry: (body, failure) => {
      if (!body.external_id) throw failure(400, "store: entry is tombstoned");
      return { id: 600 };
    },
  });
  const entryId = await importReadLaterEntry(miniflux.fetchJson, 7, { url: "https://example.com/a", title: "A" }, 1_700_000_000_000);
  assert.equal(entryId, 600);
  const imports = miniflux.requests.filter((request) => request.path.endsWith("/entries/import"));
  assert.equal(imports.length, 2);
  assert.equal(imports[1].body.external_id, "readflux:1700000000000:https://example.com/a");

  const otherFailure = fakeMiniflux({
    feeds: [{ id: 7, feed_url: FEED_URL }],
    importEntry: (_body, failure) => { throw failure(400, "url is required"); },
  });
  await assert.rejects(importReadLaterEntry(otherFailure.fetchJson, 7, { url: "https://example.com/a", title: "A" }), { detail: "url is required" });
});

test("the feed a link was saved from travels as a Miniflux tag", async () => {
  assert.equal(readLaterSourceTag(" 3-2-1 "), "via 3-2-1");
  assert.equal(readLaterSourceFromTags(["news", "via 3-2-1"]), "3-2-1");
  assert.equal(readLaterSourceFromTags(["via "]), undefined);
  assert.equal(readLaterSourceFromTags(["news"]), undefined);
  assert.equal(readLaterSourceFromTags(undefined), undefined);

  const miniflux = fakeMiniflux({ feeds: [{ id: 7, feed_url: FEED_URL }] });
  await importReadLaterEntry(miniflux.fetchJson, 7, { url: "https://example.com/a", title: "A", tags: ["via 3-2-1"] });
  await importReadLaterEntry(miniflux.fetchJson, 7, { url: "https://example.com/b", title: "B", tags: [] });
  const [tagged, untagged] = miniflux.requests.filter((request) => request.path.endsWith("/entries/import"));
  assert.deepEqual(tagged.body.tags, ["via 3-2-1"]);
  assert.equal("tags" in untagged.body, false);
});

test("a saved link ends with its Read later details instead of the ranking explanation", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /\{readLaterFeedIds\.has\(selected\.feed_id\)\s*\? <ReadLaterDetails[\s\S]*?: <RecommendationBreakdown/);
  assert.match(app, /link: \{ url: menu\.url, title, tags: readerSelected \? \[readLaterSourceTag\(readerSelected\.source\)\] : \[\] \}/);
  // The state follows the live tag, so undo is the opposite toggle.
  assert.match(app, /taggedAt=\{entryLabels\.get\(selected\.id\)\?\.later\}/);
  assert.match(app, /const tagged = taggedAt !== undefined/);
  assert.match(app, /className="link" onClick=\{onToggleReadLater\}/);
});

test("any article can be tagged for Read later from the reader toolbar or a link", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const toolbar = app.match(/<div className="readerToolbar">[\s\S]*?<\/div><\/div>/)?.[0] ?? "";
  assert.match(toolbar, /aria-pressed=\{selectedReadLater\} onClick=\{\(\) => void toggleReadLater\(selected\)\}/);
  assert.match(toolbar, /selectedReadLater \? "bi-bookmark-fill" : "bi-bookmark"/);
  // The tag is local, stored with rollback, and never sent to Miniflux.
  const setReadLater = app.slice(app.indexOf("const setReadLater = useCallback"), app.indexOf("const toggleReadLater"));
  assert.match(setReadLater, /putEntryLabels\("later", change\)/);
  assert.match(setReadLater, /catch \{\s*setEntryLabels\(\(current\) => withEntryLabel\(current, "later", restore\)\)/);
  assert.doesNotMatch(setReadLater, /minifluxFetch|updateEntry/);
  // A link to a synced entry tags it in place; only an unknown link is imported.
  assert.match(app, /if \(menu\.match\) \{[\s\S]*?setReadLater\(menu\.match\.entryId, true\)[\s\S]*?return;\s*\}/);
  assert.match(app, /await mergeEntryBatch\(\[entry\]\);\s*if \(await setReadLater\(entry\.id, true\)\)/);
  assert.match(app, /const readLater = hasEntryLabel\(entryLabelsRef\.current, entry\.id, "later"\)/);
});

test("ReadFlux no longer asks for or shows helpful and not-interested feedback", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/index.css", import.meta.url), "utf8");
  assert.doesNotMatch(app, /feedbackPill|bi-hand-thumbs|onFeedback|setFeedback|event\.feedback|draft\.feedback/);
  assert.doesNotMatch(styles, /\.feedbackPill/);
  // Raw events show whether the read was engaged, the signal ranking uses.
  assert.match(app, /t\(isEngagedReadingEvent\(event\) \? "recommendation\.engagedRead" : "recommendation\.briefRead"\)/);
});

test("the shipped Read later feed is an empty Atom document", async () => {
  const feed = await readFile(new URL(`../public/${READ_LATER_FEED_FILE}`, import.meta.url), "utf8");
  assert.match(feed, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  assert.match(feed, new RegExp(`<title>${READ_LATER_CATEGORY_TITLE}</title>`));
  assert.doesNotMatch(feed, /<entry/);
});

test("article links open the link menu instead of navigating", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  // Modified and middle clicks keep the browser's own behavior.
  assert.match(app, /event\.button !== 0 \|\| event\.ctrlKey \|\| event\.metaKey \|\| event\.shiftKey \|\| event\.altKey\) return null/);
  assert.match(app, /const link = articleLinkFromClick\(event, articleURL\);[\s\S]*?event\.preventDefault\(\);[\s\S]*?onLinkClick\(link\)/);
  // Enter on a focused link opens its menu without the reader's open-original shortcut.
  assert.match(app, /event\.key === "Enter" && event\.target instanceof Element && event\.target\.closest\("a\[href\]"\)\) event\.stopPropagation\(\)/);
  assert.match(app, /if \(settingsOpen \|\| markAllReadOpen \|\| topicSelection \|\| linkMenu\) return;/);
  const menu = app.match(/className=\{`linkMenu [\s\S]*?<\/div>\r?\n/)?.[0] ?? "";
  assert.match(menu, /role="menu"/);
  assert.equal((menu.match(/role="menuitem"/g) ?? []).length, 5);
  assert.match(menu, /readLater\.save/);
  assert.match(menu, /readLater\.openLink/);
  assert.match(app, /event\.key === "Escape" \|\| event\.key === "Tab"[\s\S]*?closeLinkMenu\(linkMenu, true\)/);
});
