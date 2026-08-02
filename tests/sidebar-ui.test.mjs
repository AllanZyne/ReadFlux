import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const main = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/index.css", import.meta.url), "utf8");
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("sidebar icons are provided by the local Bootstrap Icons package", () => {
  assert.match(packageJson.dependencies["bootstrap-icons"], /^\^?1\./);
  assert.match(main, /import "bootstrap-icons\/font\/bootstrap-icons\.css"/);
});

test("primary sidebar navigation uses Bootstrap Icons", () => {
  assert.match(app, /\["today",\s*"bi-brightness-high-fill",\s*t\("sidebar\.today"\),\s*todayUnreadCount\]/);
  assert.match(app, /\["unread",\s*"bi-[^"]+",\s*t\("sidebar\.allUnread"\),\s*unreadCount\]/);
  assert.match(app, /\["saved",\s*"bi-star-fill",\s*t\("sidebar\.saved"\),\s*savedCount\]/);
  assert.ok(app.indexOf('["today"') < app.indexOf('["unread"'));
  assert.ok(app.indexOf('["unread"') < app.indexOf('["saved"'));
  assert.match(app, /<i className=\{`bi \$\{icon\}`\} aria-hidden="true" \/>/);
  assert.doesNotMatch(app, /<b>\{icon\}<\/b>/);
  assert.match(styles, /\.sidebar nav button>i\s*\{/);
});

test("smart feed heading distinguishes Today, All unread, and Saved", () => {
  assert.match(
    app,
    /mode === "today"\s*\?\s*"sidebar\.today"\s*:\s*mode === "unread"\s*\?\s*"sidebar\.allUnread"\s*:\s*"sidebar\.saved"/,
  );
});

test("article list actions live in the title bar as NetNewsWire-style icons", () => {
  const titleBar = app.match(/<header className="feedTitle">([\s\S]*?)<\/header>/)?.[1] ?? "";

  assert.match(titleBar, /aria-label=\{t\("feed\.markAllRead"\)\}[\s\S]*?bi-check2-all/);
  assert.match(titleBar, /aria-label=\{t\("feed\.hideRead"\)\}[\s\S]*?aria-pressed=\{hideRead\}[\s\S]*?bi-filter-circle/);
  assert.match(titleBar, /setHideRead\(\(current\)\s*=>\s*!current\)/);
  assert.doesNotMatch(app, /className="feedTools"/);
  assert.match(styles, /\.feedTitleActions\s*\{/);
});

test("the subscriptions heading toggles the whole persisted section", () => {
  assert.match(app, /readflux\.sidebar\.subscriptions-collapsed/);
  assert.match(app, /subscriptionsCollapsed\s*\?\s*"bi-chevron-right"\s*:\s*"bi-chevron-down"/);
  assert.match(app, /aria-expanded=\{!subscriptionsCollapsed\}/);
  assert.match(app, /\{!subscriptionsCollapsed\s*&&\s*categorySources\.map/);

  const heading = app.match(/<div className="sideLabel">([\s\S]*?)<\/div>/)?.[1] ?? "";
  assert.match(heading, /setSubscriptionsCollapsed/);
  assert.doesNotMatch(heading, /setCollapsedCategories/);
  assert.doesNotMatch(heading, />折叠<|>展开</);
});

test("subscription collapse state survives unavailable browser storage", () => {
  assert.match(
    app,
    /function readStoredBoolean\([^)]*\)\s*\{[\s\S]*?try\s*\{[\s\S]*?localStorage\.getItem\(key\)[\s\S]*?catch\s*\{[\s\S]*?return false;/,
  );
  assert.match(
    app,
    /useState\(\s*\(\)\s*=>\s*readStoredBoolean\("readflux\.sidebar\.subscriptions-collapsed"\)/,
  );
});

test("each category folder independently reflects and toggles its state", () => {
  assert.match(app, /collapsed\s*\?\s*"bi-folder-fill"\s*:\s*"bi-folder2-open"/);
  assert.match(app, /onClick=\{\(\)\s*=>\s*toggleCategory\(category\.id\)\}/);
  assert.doesNotMatch(app, />⌄<\/button>/);
  assert.doesNotMatch(app, />▰<\/span>/);
  assert.doesNotMatch(styles, /disclosure\[aria-expanded="false"\]\s*\{\s*transform:\s*rotate/);
  assert.match(styles, /\.disclosure\[aria-expanded="true"\]\s*\{\s*color:\s*var\(--mint\)/);
});

test("a selected category highlights its folder and title as one row", () => {
  assert.match(app, /const categorySelected = topic\?\.kind === "category" && topic\.id === category\.id/);
  assert.match(app, /className=\{`groupRow \$\{categorySelected \? "selected" : ""\}`\}/);
  assert.match(app, /className="groupHead"/);
  assert.match(styles, /\.groupRow\.selected\s*\{[^}]*background:[^}]*color:/);
  assert.match(styles, /\.groupRow\.selected \.groupHead,[^{]*\.groupRow\.selected \.disclosure\s*\{[^}]*background:transparent;[^}]*color:inherit/);
});

test("category hover highlights the row without recoloring its contents", () => {
  assert.match(styles, /\.groupRow:hover\s*\{[^}]*background:/);
  const categoryHover = styles.match(/\.groupRow:hover\s*\{([^}]*)\}/)?.[1] ?? "";
  const categoryContentsHover = styles.match(/\.groupRow:hover \.groupHead,[^{]*\.groupRow:hover \.disclosure\s*\{([^}]*)\}/)?.[1] ?? "";
  const feedHover = styles.match(/\.sourceRow:hover\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.doesNotMatch(categoryHover, /color:/);
  assert.match(categoryContentsHover, /background:transparent/);
  assert.doesNotMatch(categoryContentsHover, /color:/);
  assert.match(feedHover, /background:/);
  assert.doesNotMatch(feedHover, /color:/);
});

test("category rows share the smart-feed row grid and horizontal padding", () => {
  assert.match(
    styles,
    /\.groupRow\s*\{[^}]*grid-template-columns:24px minmax\(0,1fr\);[^}]*gap:4px;[^}]*padding:0 9px;/,
  );
  assert.match(styles, /\.disclosure\s*\{[^}]*width:24px;/);
  assert.match(styles, /\.groupHead\s*\{[^}]*padding:0;/);
});

test("sidebar icons use optical sizing for Today and All unread", () => {
  assert.match(styles, /\.sidebar nav button>i\s*\{[^}]*font:500 15px\/1/);
  assert.match(styles, /\.disclosure\s*\{[^}]*font-size:15px;/);
  assert.match(styles, /\.sidebar nav button>i\.bi-brightness-high-fill\s*\{[^}]*font-size:17px;/);
  assert.match(styles, /\.sidebar nav button>i\.bi-circle-fill\s*\{[^}]*font-size:12px;/);
});

test("the empty-state reset button uses a light surface in the day theme", () => {
  assert.match(
    styles,
    /\.shell\[data-theme="day"\] \.empty button\s*\{[^}]*border-color:#afc1df;[^}]*background:#fff;[^}]*color:#2559c2;/,
  );
});

test("long category titles are truncated within their row", () => {
  assert.match(
    styles,
    /\.groupHead>span(?:,|\s*\{)[^}]*overflow:hidden;[^}]*text-overflow:ellipsis;[^}]*white-space:nowrap;/,
  );
  assert.doesNotMatch(styles, /\.groupHead>span:nth-child\(2\)/);
});

test("the sidebar no longer links to Miniflux", () => {
  assert.doesNotMatch(app, /打开 Miniflux/);
  assert.doesNotMatch(app, /className="manage"/);
  assert.doesNotMatch(styles, /\.manage\s*\{\s*position/);
  assert.doesNotMatch(styles, /\.manage:hover/);
});
