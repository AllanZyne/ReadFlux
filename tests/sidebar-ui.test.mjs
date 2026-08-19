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
  assert.match(app, /\["today",\s*"bi-brightness-high-fill",\s*t\("sidebar\.today"\),\s*navCounts\.today\]/);
  assert.match(app, /\["all",\s*"bi-inbox",\s*t\("sidebar\.all"\),\s*navCounts\.all\]/);
  assert.match(app, /\["updated",\s*"bi-bell",\s*t\("sidebar\.updated"\),\s*navCounts\.updated\]/);
  assert.match(app, /\["saved",\s*"bi-star-fill",\s*t\("sidebar\.saved"\),\s*navCounts\.saved\]/);
  assert.ok(app.indexOf('["today"') < app.indexOf('["all"'));
  assert.ok(app.indexOf('["all"') < app.indexOf('["updated"'));
  assert.ok(app.indexOf('["updated"') < app.indexOf('["saved"'));
  assert.doesNotMatch(app, /sidebar\.allUnread/);
  assert.match(app, /<i className=\{`bi \$\{icon\}`\} aria-hidden="true" \/>/);
  assert.doesNotMatch(app, /<b>\{icon\}<\/b>/);
  assert.match(styles, /\.sidebar nav button>i\s*\{/);
  assert.match(styles, /\.shell\[data-theme="day"\] \.sidebar nav button\.active\{background:#3568d4;color:#fff;box-shadow:none\}/);
  assert.match(styles, /\.shell\[data-theme="night"\] \.sidebar nav button\.active\{background:#315da8;color:#fff;box-shadow:none\}/);
});

test("smart feed heading combines the selected feed with its source scope", () => {
  assert.match(app, /topicTitle\s*\?\s*`\$\{t\(`sidebar\.\$\{mode\}`\)\} · \$\{topicTitle\}`\s*:\s*t\(`sidebar\.\$\{mode\}`\)/);
});

test("article list actions live in the title bar as NetNewsWire-style icons", () => {
  const titleBar = app.match(/<header className="feedTitle">([\s\S]*?)<\/header>/)?.[1] ?? "";

  assert.match(titleBar, /aria-label=\{t\("feed\.markAllRead"\)\}[\s\S]*?bi-check2-all/);
  assert.match(titleBar, /disabled=\{mode === "updated"\}[\s\S]*?aria-label=\{t\("feed\.unreadOnly"\)\}[\s\S]*?aria-pressed=\{hideRead\}[\s\S]*?bi-filter-circle/);
  assert.match(titleBar, /setHideReadByMode\(\(current\) => \(\{ \.\.\.current, \[mode\]: !current\[mode\] \}\)\)/);
  assert.doesNotMatch(app, /className="feedTools"/);
  assert.match(styles, /\.feedTitleActions\s*\{/);
  assert.match(styles, /\.feedTitleActions button:disabled\s*\{/);
});

test("article rows align full-width titles with right-aligned time and status markers", () => {
  assert.match(app, /className="storyMain"[\s\S]*?className="storySource"[\s\S]*?<h2>\{story\.title\}<\/h2>[\s\S]*?<footer>\{t\("feed\.minutes"/);
  assert.match(app, /className="storyStatus"[\s\S]*?<time>\{formatZonedTime\(story\.published_at, activeTimeZone\)\}<\/time>[\s\S]*?<i aria-hidden="true" \/>/);
  assert.doesNotMatch(app, /<h2>\{story\.title\}<\/h2><p>\{story\.summary\}<\/p>/);
  assert.match(app, /\$\{story\.starred \? "starred" : ""\}/);
  assert.match(app, /const updated = story\.status === "read" && \(entryLabels\.get\(story\.id\)\?\.includes\("updated"\) \?\? false\)/);
  assert.match(app, /story\.status === "unread"[\s\S]*?"feed\.unread"[\s\S]*?updated[\s\S]*?"feed\.updated"/);
  assert.match(app, /currentMode === "updated" && entry\.status === "read" && updatedIds\.has\(entry\.id\)/);
  assert.match(app, /timeBuckets: new Map|const timeBuckets = mode === "today"/);
  assert.match(styles, /\.story\{display:grid;[^}]*grid-template-columns:minmax\(0,1fr\) auto;[^}]*grid-template-rows:auto auto auto;[^}]*grid-template-areas:"source time" "title title" "footer dot";[^}]*column-gap:10px;[^}]*padding:13px 14px 12px/);
  assert.match(styles, /\.storyMain,\.storyStatus\{display:contents\}/);
  assert.match(styles, /\.story h2\{grid-area:title;[^}]*padding-right:8px;/);
  assert.match(styles, /\.storyStatus time\{grid-area:time;justify-self:end;/);
  assert.match(styles, /\.storyStatus>i\{grid-area:dot;align-self:end;justify-self:end;/);
  assert.match(styles, /\.storySource\{[^}]*gap:5px;[^}]*font-size:10px\}/);
  assert.match(styles, /\.story \.sourceIcon\{width:14px;height:14px;[^}]*font-size:7px\}/);
  assert.match(styles, /\.story:not\(\.read\) \.storyStatus>i\{background:var\(--mint\)\}/);
  assert.match(styles, /\.story\.read\.updated:not\(\.starred\) \.storyStatus>i\{background:#10b981\}/);
  assert.match(styles, /\.story\.starred \.storyStatus>i\{background:var\(--yellow\)\}/);
  assert.match(styles, /\.shell\[data-theme="day"\] \.story\.starred \.storyStatus>i\{background:#eab308\}/);
  assert.match(styles, /\.shell\[data-theme="night"\] \.story\.starred \.storyStatus>i\{background:#facc15\}/);
  assert.doesNotMatch(styles, /pulseRing/);
});

test("the reader does not reserve a persistent previous-next footer", () => {
  assert.doesNotMatch(app, /className="readerFoot"/);
  assert.doesNotMatch(styles, /readerFoot/);
  assert.match(styles, /\.readerScroll\{padding-top:0;padding-bottom:32px\}/);
  assert.match(styles, /\.toast\{position:fixed;right:25px;bottom:20px;/);
});

test("unread-only state is isolated per smart feed", () => {
  assert.match(app, /useState<Record<ListMode, boolean>>\(\{[\s\S]*?today: false,[\s\S]*?all: false,[\s\S]*?updated: false,[\s\S]*?saved: false/);
  assert.match(app, /const hideRead = mode !== "updated" && hideReadByMode\[mode\]/);
  assert.match(app, /hideReadRef\.current = nextMode !== "updated" && hideReadByMode\[nextMode\]/);
  assert.match(app, /today: hideReadByMode\.today \? unreadCount : todayCount/);
  assert.match(app, /all: hideReadByMode\.all \? unreadCount : allCount/);
  assert.match(app, /saved: hideReadByMode\.saved[\s\S]*?entry\.status === "unread" && entry\.starred/);
});

test("mark all as read requires the selected anchored confirmation", () => {
  const confirmation = app.match(/<section\s+className="markAllReadConfirm"([\s\S]*?)<\/section>/)?.[0] ?? "";

  assert.match(app, /onClick=\{requestMarkVisibleRead\}/);
  assert.match(app, /const visibleMarkReadCount = useMemo\([\s\S]*?story\.status === "unread" \|\| entryLabels\.get\(story\.id\)\?\.includes\("updated"\)[\s\S]*?\[entryLabels, visible\]/);
  assert.match(app, /disabled=\{!visibleMarkReadCount\}/);
  assert.match(confirmation, /count: visibleMarkReadCount/);
  assert.match(app, /className=\{markAllReadOpen \? "markAllReadSpotlight" : ""\}/);
  assert.match(app, /event\.shiftKey[\s\S]*?requestMarkVisibleRead\(\)/);
  assert.match(confirmation, /role="dialog"/);
  assert.match(confirmation, /aria-modal="true"/);
  assert.match(confirmation, /feed\.markAllReadConfirm/);
  assert.equal((confirmation.match(/<button/g) ?? []).length, 1);
  assert.match(confirmation, /common\.confirm/);
  assert.doesNotMatch(confirmation, /<p|common\.cancel/);
  const backdropRule = styles.match(/\.markAllReadBackdrop\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(backdropRule, /background:transparent/);
  assert.doesNotMatch(backdropRule, /backdrop-filter|filter:|animation:/);
  assert.match(styles, /\.feedTitleActions button\.markAllReadSpotlight\s*\{[^}]*z-index:72;[^}]*border:1px solid var\(--mint\)/);
  const spotlightRule = styles.match(/\.feedTitleActions button\.markAllReadSpotlight\s*\{([^}]*)\}/)?.[1] ?? "";
  const confirmRule = styles.match(/\.markAllReadConfirm\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.doesNotMatch(spotlightRule, /box-shadow/);
  assert.doesNotMatch(confirmRule, /box-shadow/);
  assert.match(styles, /\.markAllReadConfirm\s*\{[^}]*position:fixed;[^}]*border:1px solid var\(--line\);[^}]*border-radius:14px;[^}]*background:var\(--panel2\)/);
  assert.match(styles, /\.markAllReadConfirm:before\s*\{/);
});

test("article text selection uses a single anchored follow-topic confirmation", () => {
  const confirmation = app.match(/<section\s+className="topicSelectionConfirm"([\s\S]*?)<\/section>/)?.[0] ?? "";
  assert.match(app, /onTextSelection=\{requestTopicSelection\}/);
  assert.match(app, /event\.key === "Tab"[\s\S]*?event\.preventDefault\(\)[\s\S]*?topicSelectionConfirmRef\.current\?\.focus\(\)/);
  assert.match(confirmation, /role="dialog"/);
  assert.match(confirmation, /aria-modal="true"/);
  assert.equal((confirmation.match(/<button/g) ?? []).length, 1);
  assert.match(confirmation, /recommendation\.followSelectedTopic/);
  assert.doesNotMatch(confirmation, /<h2|<p/);
  assert.match(styles, /\.topicSelectionBackdrop\{[^}]*position:fixed;[^}]*background:transparent/);
  assert.match(styles, /\.topicSelectionConfirm\{[^}]*position:fixed;[^}]*width:min\(112px,[^}]*border:1px solid var\(--line\);[^}]*border-radius:10px;[^}]*background:var\(--panel2\)/);
  assert.match(styles, /\.topicSelectionConfirm:before\{[^}]*bottom:-5px;[^}]*border-right:1px solid var\(--line\);[^}]*border-bottom:1px solid var\(--line\)/);
  assert.doesNotMatch(app, /data-placement=\{topicSelection\.placement\}/);
});

test("feed article counts are hidden by default and controlled from General settings", () => {
  assert.match(app, /showFeedArticleCount: false/);
  assert.match(app, /checked=\{settings\.showFeedArticleCount\}/);
  assert.match(app, /setShowFeedArticleCount\(event\.target\.checked\)/);
  assert.match(app, /resetsSource \? "↩" : settings\.showFeedArticleCount \? count : ""/);
  assert.match(app, /<em>\{settings\.showFeedArticleCount \? categoryCount \|\| "" : ""\}<\/em>/);
  assert.match(app, /<em>\{settings\.showFeedArticleCount \? countByFeed\.get\(feed\.id\) \|\| "" : ""\}<\/em>/);
  assert.match(app, /\(settings\.showFeedArticleCount \|\| error && entries\.length > 0\) && <small>/);
  assert.match(app, /settings\.showFeedArticleCount[\s\S]*?feed\.recommendedCount[\s\S]*?feed\.updatedCount[\s\S]*?feed\.articleCount/);
  assert.match(styles, /\.settingToggle>input:checked\+i\{/);
});

test("scroll-to-read is enabled by default and configurable from General settings", () => {
  const start = app.indexOf("const markEntriesReadFromScroll = useCallback");
  const end = app.indexOf("const handleStoryListScroll", start);
  const markEntriesReadFromScroll = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(app, /markReadOnScroll: true/);
  assert.match(app, /checked=\{settings\.markReadOnScroll\}/);
  assert.match(app, /setMarkReadOnScroll\(event\.target\.checked\)/);
  assert.match(app, /if \(!settings\.markReadOnScroll \|\| list\.scrollTop <= previousScrollTop\) return;/);
  assert.match(app, /storyIdsPassedByScroll\(/);
  assert.match(app, /data-entry-id=\{story\.id\}/);
  assert.match(markEntriesReadFromScroll, /unreadIds\.map\(\(entryId\) => \(\{ entryId, field: "status", value: "read" \}\)\)/);
  assert.match(markEntriesReadFromScroll, /const updatedIds = candidateIds\.filter[\s\S]*?entryLabels\.get\(id\)\?\.includes\("updated"\)/);
  assert.match(markEntriesReadFromScroll, /updatedIds\.map\(\(id\) => removeEntryLabel\(config, id, "updated"\)\)/);
});

test("opening an updated article preserves the current Today or Updated snapshot", () => {
  assert.match(
    app,
    /const wasUpdatedWhenListed = \(mode === "today" \|\| mode === "updated"\)[\s\S]*?frozenVisibleOrder\.initialLabels\.get\(story\.id\)\?\.includes\("updated"\)/,
  );
  assert.match(app, /if \(!wasUpdatedWhenListed && !isEntryInSmartFeed/);
});

test("mark all as read also clears Updated labels from the visible list", () => {
  const start = app.indexOf("const markVisibleRead = useCallback");
  const end = app.indexOf("const positionMarkAllRead", start);
  const markVisibleRead = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(markVisibleRead, /const updatedIds = visible[\s\S]*?entryLabels\.get\(story\.id\)\?\.includes\("updated"\)/);
  assert.match(markVisibleRead, /setEntryLabels\(labelsAfter\)/);
  assert.match(markVisibleRead, /Promise\.all\(updatedIds\.map\(\(id\) => removeEntryLabel\(config, id, "updated"\)\)\)/);
  assert.match(markVisibleRead, /setListReadSnapshot\(new Map\(after\.map/);
});

test("the subscriptions heading toggles the whole persisted section", () => {
  assert.match(app, /readflux\.sidebar\.subscriptions-collapsed/);
  assert.match(app, /subscriptionsCollapsed\s*\?\s*"bi-chevron-right"\s*:\s*"bi-chevron-down"/);
  assert.match(app, /aria-expanded=\{!subscriptionsCollapsed\}/);
  assert.match(app, /\{!subscriptionsCollapsed\s*&&\s*visibleCategorySources\.map/);

  const heading = app.match(/<div className="sideLabel">([\s\S]*?)<\/div>/)?.[1] ?? "";
  assert.match(heading, /setSubscriptionsCollapsed/);
  assert.doesNotMatch(heading, /setCollapsedCategories/);
  assert.doesNotMatch(heading, />折叠<|>展开</);
});

test("scheme A resets the source scope through every smart feed", () => {
  assert.match(app, /onClick=\{\(\) => switchListContext\(key, null\)\}/);
  assert.match(app, /const resetsSource = mode === key && topic !== null/);
  assert.match(app, /resetsSource \? "↩" : settings\.showFeedArticleCount \? count : ""/);
  assert.match(app, /sidebar\.resetSource/);
  assert.doesNotMatch(app, /allSubscriptions|所有订阅/);
});

test("midnight score decay does not rebuild the frozen list snapshot", () => {
  const start = app.indexOf("const nextMidnight");
  const end = app.indexOf("}, [todayClock, activeTimeZone]);", start);
  const midnightEffect = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(midnightEffect, /setTodayClock\(Date\.now\(\)\)/);
  assert.doesNotMatch(midnightEffect, /setVisibleIds|setListReadSnapshot/);
});

test("changing smart feed, category, or feed closes the open article", () => {
  assert.match(app, /const switchListContext = useCallback\([\s\S]*?commitActiveEvent\(\);[\s\S]*?persistActive\(\);[\s\S]*?setSelectedId\(null\);[\s\S]*?navigateToList\(\);[\s\S]*?setMobileView\("list"\)/);
  assert.match(app, /switchListContext\(mode, \{ kind: "category", id: category\.id \}\)/);
  assert.match(app, /switchListContext\(mode, \{ kind: "feed", id: feed\.id \}\)/);
});

test("subscription counts follow the smart feed and unread-only filter", () => {
  assert.match(app, /if \(!sourceSnapshot\.statuses\.has\(entry\.id\)\) return;/);
  assert.match(app, /status: statusWhenCaptured[\s\S]*?sourceSnapshot\.labels/);
  assert.match(app, /mode !== "updated" && hideRead && statusWhenCaptured !== "unread"/);
  assert.match(app, /const visibleCategorySources = useMemo/);
});

test("category and feed buttons keep their smart-feed snapshot until reset or mode change", () => {
  assert.match(app, /const changingSmartFeed = modeRef\.current !== nextMode/);
  assert.match(app, /const returningToSmartFeed = !changingSmartFeed && currentTopic !== null && nextTopic === null/);
  assert.match(app, /if \(changingSmartFeed \|\| returningToSmartFeed\) \{\s*captureSourceSnapshot\(entriesRef\.current, entryLabels\);/);
  assert.match(app, /const refreshList = useCallback\([\s\S]*?captureSourceSnapshot\(entriesRef\.current, entryLabels\)/);
  assert.match(app, /if \(initialCacheHydration\) \{[\s\S]*?if \(cached\.length\) captureSourceSnapshot\(cached, labels\);/);
  assert.match(app, /if \(loading \|\| sourceSnapshotInitialized\.current \|\| !entries\.length\) return;[\s\S]*?captureSourceSnapshot\(entries, entryLabels\);/);
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

test("sidebar icons use optical sizing for Today", () => {
  assert.match(styles, /\.sidebar nav button>i\s*\{[^}]*font:500 15px\/1/);
  assert.match(styles, /\.disclosure\s*\{[^}]*font-size:15px;/);
  assert.match(styles, /\.sidebar nav button>i\.bi-brightness-high-fill\s*\{[^}]*font-size:17px;/);
});

test("the empty-state reset button uses a light surface in the day theme", () => {
  assert.match(
    styles,
    /\.shell\[data-theme="day"\] \.empty button\s*\{[^}]*border-color:#afc1df;[^}]*background:#fff;[^}]*color:#2559c2;/,
  );
  assert.match(styles, /\.shell\[data-theme="day"\] \.readerEmpty h2\{color:#26364b\}/);
  assert.match(styles, /\.shell\[data-theme="day"\] \.readerEmpty p\{color:#64748a\}/);
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
  assert.match(app, /const refreshStatus = [\s\S]*?syncProgressLabel[\s\S]*?refreshing[\s\S]*?sync\.fullSyncing[\s\S]*?syncedAt[\s\S]*?feed\.syncedAt/);
  assert.match(app, /title=\{refreshStatus\}/);
  assert.match(app, /aria-label=\{refreshStatus\}/);
  assert.match(app, /const refreshBusy = refreshing \|\| loading/);
  assert.match(app, /aria-disabled=\{refreshBusy\}/);
  assert.match(app, /const refreshFeeds = async \(\) => \{\s*if \(refreshInFlight\.current \|\| loading\) return;/);
  assert.doesNotMatch(app, /className=\{`toolbarButton[^>]*\sdisabled=\{loading\}/);
  assert.match(app, /refreshFailed \|\| error \? "bi-exclamation-triangle-fill" : "bi-arrow-clockwise"/);
  assert.match(app, /setRefreshFailed\(false\)[\s\S]*?setRefreshFailed\(true\)/);
  assert.match(app, /refreshInFlight\.current = true;[\s\S]*?setRefreshing\(true\)[\s\S]*?finally\s*\{\s*refreshInFlight\.current = false;[\s\S]*?setRefreshing\(false\)/);
  assert.match(app, /const syncSucceeded = await load\(\{\s*mode:\s*"full"\s*\}\);\s*if \(!syncSucceeded\)\s*\{[\s\S]*?setRefreshFailed\(true\);[\s\S]*?return;/);
  assert.match(app, /setSyncedAt\(new Date\(\)\);[\s\S]*?return true;[\s\S]*?catch \(cause\)[\s\S]*?return false;/);
  assert.match(styles, /\.toolbarButton\.failed\s*\{[^}]*color:/);
  assert.match(styles, /\.toolbarButton\.spinning>i\s*\{[^}]*animation:spin/);
});

test("the three-column workspace fills the viewport without a global banner", () => {
  assert.match(styles, /\.workspace\s*\{[^}]*height:100vh;/);
  assert.match(styles, /grid-template-columns:minmax\(190px,min\(var\(--sidebar-width,250px\),24vw\)\) 5px minmax\(300px,min\(var\(--list-width,430px\),38vw\)\) 5px minmax\(0,1fr\)/);
  assert.match(styles, /grid-template-columns:minmax\(160px,min\(var\(--sidebar-width,250px\),22vw\)\) 5px minmax\(280px,min\(var\(--list-width,430px\),38vw\)\) 5px minmax\(0,1fr\)/);
  assert.match(styles, /\.sidebar\{\s*display:flex;[\s\S]*?scrollbar-gutter:auto;\s*\}/);
  assert.match(styles, /\.sidebarHeader\s*\{[^}]*height:72px;/);
  assert.doesNotMatch(styles, /\.topbar\s*\{/);
});

test("source rows sit as close to their scrollbar as article rows do", () => {
  assert.match(styles, /\.sidebarScroll\{[\s\S]*?padding:12px 0 16px 10px;[\s\S]*?scrollbar-gutter:stable;/);
  assert.match(styles, /\.storyList\{padding:0;/);
  assert.match(styles, /\.sideLabel\{[^}]*margin:13px 0 4px 7px;/);
  assert.match(styles, /\.workspace\.mobile-sources \.sidebarScroll\{padding:14px 0 14px 10px\}/);
});

test("article panel headers do not draw horizontal divider lines", () => {
  const feedTitleRules = [...styles.matchAll(/\.feedTitle\s*\{([^}]*)\}/g)];
  const readerToolbarRules = [...styles.matchAll(/\.readerToolbar\s*\{([^}]*)\}/g)];

  assert.ok(feedTitleRules.length > 0);
  assert.ok(readerToolbarRules.length > 0);
  assert.ok(feedTitleRules.every((match) => !/border-bottom\s*:/.test(match[1])));
  assert.ok(readerToolbarRules.every((match) => !/border-bottom\s*:/.test(match[1])));
});

test("reading-time ticks stay isolated from the memoized article body", () => {
  const metadataStart = app.indexOf("function ArticleMetadata(");
  const articleBodyStart = app.indexOf("const ArticleBody = memo(");
  const eventDraftStart = app.indexOf("type EventDraft", articleBodyStart);

  assert.ok(metadataStart >= 0, "ArticleMetadata component not found");
  assert.ok(articleBodyStart > metadataStart, "ArticleBody must follow ArticleMetadata");
  assert.ok(eventDraftStart > articleBodyStart, "EventDraft must follow ArticleBody");

  const metadata = app.slice(metadataStart, articleBodyStart);
  const articleBody = app.slice(articleBodyStart, eventDraftStart);

  assert.match(metadata, /useState\(initialReadingSeconds\)/);
  assert.match(metadata, /onReadingTick\(\)[\s\S]*?setReadingSeconds/);
  assert.match(metadata, /className="articleReadingTime"/);
  assert.match(app, /key=\{`\$\{selected\.id\}:\$\{selectedReadingSeconds\}`\}/);
  assert.match(app, /const updatedActiveEvent = next\.find[\s\S]*?activeEvent\.current = updatedActiveEvent \? \{ \.\.\.updatedActiveEvent \} : null/);
  assert.match(articleBody, /const markup = useMemo/);
  assert.match(articleBody, /dangerouslySetInnerHTML=\{markup\}/);
  assert.doesNotMatch(articleBody, /readingSeconds|onReadingTick/);
  assert.match(styles, /\.articleReadingTime\s*\{[^}]*color:var\(--mint\);[^}]*font-variant-numeric:tabular-nums/);
});

test("media loading settings offer scoped defaults and per-feed overrides", () => {
  assert.match(app, /updateDefaultImageLoadingMode/);
  assert.match(app, /updateFeedImageLoadingMode/);
  assert.match(app, /value="direct-no-referrer"/);
  assert.match(app, /value="direct-origin"/);
  assert.match(app, /imageProxyAvailable && <option value="proxy"/);
  assert.match(app, /value="inherit"/);
  assert.match(styles, /\.imageDefaultMode\s*\{/);
  assert.match(styles, /\.feedSettingRow>select\s*\{/);
});

test("proxy mode is always available and falls back at media load time", () => {
  assert.match(app, /const imageProxyAvailable = true/);
  assert.doesNotMatch(app, /detectMinifluxProxySupport/);
  assert.match(app, /handleArticleImageError/);
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

test("the media default is the only compact select row in sync settings", () => {
  const syncStart = app.indexOf('{tab === "sync" && <>');
  const feedsStart = app.indexOf('{tab === "feeds" &&');
  const syncPanel = app.slice(syncStart, feedsStart);

  assert.equal([...syncPanel.matchAll(/className="syncSelectSetting[^"]*"/g)].length, 1);
  assert.doesNotMatch(syncPanel, /sync\.range|entryLookbackDays|LOOKBACK_OPTIONS/);
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

test("raw reading events use a fixed-height table with an internal sticky header", () => {
  assert.match(styles, /\.eventTable\{[^}]*height:420px;[^}]*overflow-y:auto/);
  assert.match(styles, /\.eventTableHead\{[^}]*position:sticky;[^}]*top:0;[^}]*z-index:1/);
});
