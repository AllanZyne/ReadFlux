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
  assert.match(app, /\["today",\s*"bi-brightness-high-fill",\s*t\("sidebar\.today"\),\s*todayCount\]/);
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

test("the source sidebar owns the app title and global actions", () => {
  const sidebar = app.match(/<aside className="sidebar"[\s\S]*?<\/aside>/)?.[0] ?? "";
  const sidebarBrand = sidebar.match(/<div className="sidebarBrand">([\s\S]*?)<\/div>/)?.[1] ?? "";
  const feedTitle = app.match(/<header className="feedTitle">([\s\S]*?)<\/header>/)?.[1] ?? "";

  assert.match(sidebar, /<header className="sidebarHeader">/);
  assert.match(sidebar, /<strong>ReadFlux<\/strong>/);
  assert.match(sidebar, /bi-arrow-clockwise/);
  assert.match(sidebar, /setSettingsOpen\(true\)/);
  assert.match(sidebar, /className="sidebarProgress"/);
  assert.doesNotMatch(sidebarBrand, /syncProgressLabel|syncError|feed\.syncedAt/);
  assert.doesNotMatch(feedTitle, /feed\.syncedAt/);
  assert.doesNotMatch(app, /<header className="topbar">/);
  assert.doesNotMatch(app, /id="search"/);
});

test("the refresh button exposes sync state on hover and changes icon after failure", () => {
  assert.match(app, /const refreshStatus = [\s\S]*?syncProgressLabel[\s\S]*?refreshing[\s\S]*?sync\.latest[\s\S]*?syncedAt[\s\S]*?feed\.syncedAt/);
  assert.match(app, /title=\{refreshStatus\}/);
  assert.match(app, /aria-label=\{refreshStatus\}/);
  assert.match(app, /const refreshBusy = refreshing \|\| loading/);
  assert.match(app, /aria-disabled=\{refreshBusy\}/);
  assert.match(app, /const refreshFeeds = async \(\) => \{\s*if \(refreshInFlight\.current \|\| loading\) return;/);
  assert.doesNotMatch(app, /className=\{`toolbarButton[^>]*\sdisabled=\{loading\}/);
  assert.match(app, /refreshFailed \|\| error \? "bi-exclamation-triangle-fill" : "bi-arrow-clockwise"/);
  assert.match(app, /setRefreshFailed\(false\)[\s\S]*?setRefreshFailed\(true\)/);
  assert.match(app, /refreshInFlight\.current = true;[\s\S]*?setRefreshing\(true\)[\s\S]*?finally\s*\{\s*refreshInFlight\.current = false;[\s\S]*?setRefreshing\(false\)/);
  assert.match(app, /const syncSucceeded = await load\(\);\s*if \(!syncSucceeded\)\s*\{[\s\S]*?setRefreshFailed\(true\);[\s\S]*?return;/);
  assert.match(app, /setSyncedAt\(new Date\(\)\);[\s\S]*?return true;[\s\S]*?catch \(cause\)[\s\S]*?return false;/);
  assert.match(styles, /\.toolbarButton\.failed\s*\{[^}]*color:/);
  assert.match(styles, /\.toolbarButton\.spinning>i\s*\{[^}]*animation:spin/);
});

test("the three-column workspace fills the viewport without a global banner", () => {
  assert.match(styles, /\.workspace\s*\{[^}]*height:100vh;/);
  assert.match(styles, /\.sidebarHeader\s*\{[^}]*height:72px;/);
  assert.doesNotMatch(styles, /\.topbar\s*\{/);
});

test("article panel headers do not draw horizontal divider lines", () => {
  const feedTitleRules = [...styles.matchAll(/\.feedTitle\s*\{([^}]*)\}/g)];
  const readerToolbarRules = [...styles.matchAll(/\.readerToolbar\s*\{([^}]*)\}/g)];

  assert.ok(feedTitleRules.length > 0);
  assert.ok(readerToolbarRules.length > 0);
  assert.ok(feedTitleRules.every((match) => !/border-bottom\s*:/.test(match[1])));
  assert.ok(readerToolbarRules.every((match) => !/border-bottom\s*:/.test(match[1])));
});

test("image loading settings offer scoped defaults and per-feed overrides", () => {
  assert.match(app, /updateDefaultImageLoadingMode/);
  assert.match(app, /updateFeedImageLoadingMode/);
  assert.match(app, /value="direct-no-referrer"/);
  assert.match(app, /value="direct-origin"/);
  assert.match(app, /imageProxyAvailable && <option value="proxy"/);
  assert.match(app, /value="inherit"/);
  assert.match(styles, /\.imageDefaultMode\s*\{/);
  assert.match(styles, /\.feedSettingRow>select\s*\{/);
});

test("proxy mode is exposed only after probing decodable links from the current server", () => {
  assert.match(app, /\/v1\/entries\?limit=20&order=published_at&direction=desc/);
  assert.match(app, /containsMinifluxProxyURL\(entry\.content, config\.url\)/);
  assert.match(app, /imageProxySupport\.url === config\.url/);
  assert.match(app, /shouldRefreshProxyContent\(selected\.content, config\.url, selectedImageMode, alreadyAttempted\)/);
});

test("settings give feeds a dedicated tab between sync and recommendation", () => {
  assert.match(app, /useState<"general" \| "sync" \| "feeds" \| "recommendation">/);
  const tabs = app.match(/<nav className="settingsTabs"[\s\S]*?<\/nav>/)?.[0] ?? "";
  assert.ok(tabs.indexOf('tab === "sync"') < tabs.indexOf('tab === "feeds"'));
  assert.ok(tabs.indexOf('tab === "feeds"') < tabs.indexOf('tab === "recommendation"'));
  assert.match(tabs, /t\("settings\.feeds"\)/);
});

test("global image mode lives in sync while per-feed mode uses a master-detail inspector", () => {
  const generalStart = app.indexOf('{tab === "general" && <>');
  const syncStart = app.indexOf('{tab === "sync" && <>');
  const feedsStart = app.indexOf('{tab === "feeds" &&');
  const recommendationStart = app.indexOf('{tab === "recommendation" &&');
  const generalPanel = app.slice(generalStart, syncStart);
  const syncPanel = app.slice(syncStart, feedsStart);
  const feedsPanel = app.slice(feedsStart, recommendationStart);

  assert.doesNotMatch(generalPanel, /setDefaultImageMode|setFeedImageMode/);
  assert.match(syncPanel, /setDefaultImageMode/);
  assert.doesNotMatch(syncPanel, /setFeedImageMode/);
  assert.match(feedsPanel, /className="feedSettingsLayout"/);
  assert.match(feedsPanel, /className="feedSettingsNav"/);
  assert.match(feedsPanel, /setSelectedFeedId\(feed\.id\)/);
  assert.match(feedsPanel, /className="feedSettingsInspector"/);
  assert.match(feedsPanel, /setFeedImageMode\(selectedFeed\.id, event\.target\.value\)/);
  assert.match(styles, /\.feedSettingsLayout\s*\{/);
  assert.match(styles, /\.feedSettingRow\s*\{/);
});

test("all settings and onboarding selects share the lightweight outlined treatment", () => {
  assert.match(
    styles,
    /:is\(\.settingsDialog,\.connectCard\) select\s*\{[^}]*appearance:none;[^}]*padding-right:38px;[^}]*background-image:url\([^}]*background-position:right 12px center;[^}]*cursor:pointer;/,
  );
  assert.match(styles, /:is\(\.settingsDialog,\.connectCard\) select:hover\s*\{[^}]*border-color:/);
  assert.match(styles, /:is\(\.settingsDialog,\.connectCard\) select:focus\s*\{[^}]*box-shadow:/);
  assert.match(styles, /:is\(\.settingsDialog,\.connectCard\) select:disabled\s*\{[^}]*cursor:not-allowed;/);
  assert.doesNotMatch(styles, /:where\(\.settingsDialog,\.connectCard\) select/);
});

test("Miniflux range and image defaults use the same compact sync row", () => {
  const syncStart = app.indexOf('{tab === "sync" && <>');
  const feedsStart = app.indexOf('{tab === "feeds" &&');
  const syncPanel = app.slice(syncStart, feedsStart);

  assert.equal([...syncPanel.matchAll(/className="syncSelectSetting[^"]*"/g)].length, 2);
  assert.match(
    styles,
    /\.syncSelectSetting\s*\{[^}]*grid-template-columns:minmax\(150px,180px\) minmax\(220px,1fr\);[^}]*align-items:center;/,
  );
  assert.match(styles, /\.syncSelectSetting small\s*\{[^}]*grid-column:2;/);
});

test("settings dialog typography keeps labels and supporting text readable", () => {
  assert.match(styles, /\.settingsDialog label>span\s*\{[^}]*font-size:13px;[^}]*font-weight:500;/);
  assert.match(styles, /\.settingsDialog :is\(input,select\)\s*\{[^}]*font-size:13px;/);
  assert.match(styles, /\.settingsDialog :is\(p,small\)\s*\{[^}]*font-size:12px;/);
});
