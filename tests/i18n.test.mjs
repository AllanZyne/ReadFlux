import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const i18nModule = await import("../src/i18n.ts").catch(() => ({}));

const flattenKeys = (value, prefix = "") => Object.entries(value).flatMap(([key, child]) => {
  const path = prefix ? `${prefix}.${key}` : key;
  return child && typeof child === "object" && !Array.isArray(child)
    ? flattenKeys(child, path)
    : [path];
});

const flattenEntries = (value, prefix = "") => Object.entries(value).flatMap(([key, child]) => {
  const path = prefix ? `${prefix}.${key}` : key;
  return child && typeof child === "object" && !Array.isArray(child)
    ? flattenEntries(child, path)
    : [[path, child]];
});

test("browser language variants resolve to one of ReadFlux's supported locales", () => {
  assert.equal(typeof i18nModule.normalizeLanguage, "function");
  assert.equal(i18nModule.normalizeLanguage("en-US"), "en");
  assert.equal(i18nModule.normalizeLanguage("fr-CA"), "fr");
  assert.equal(i18nModule.normalizeLanguage("zh-Hans-CN"), "zh-CN");
  assert.equal(i18nModule.normalizeLanguage("de-DE"), "en");
  assert.equal(i18nModule.normalizeLanguage(undefined), "en");
});

test("English, Chinese, and French catalogs expose the same complete key set", async () => {
  const locales = await Promise.all(["en", "zh-CN", "fr"].map(async (locale) => {
    const url = new URL(`../src/locales/${locale}.json`, import.meta.url);
    return JSON.parse(await readFile(url, "utf8").catch(() => "null"));
  }));

  locales.forEach((locale) => assert.notEqual(locale, null));
  const [englishKeys, ...translatedKeys] = locales.map((locale) => flattenKeys(locale).sort());
  assert.ok(englishKeys.length >= 100, "the catalog should cover the whole application interface");
  translatedKeys.forEach((keys) => assert.deepEqual(keys, englishKeys));

  const catalogs = locales.map((locale) => new Map(flattenEntries(locale)));
  for (const key of englishKeys) {
    const reference = catalogs[0].get(key);
    assert.equal(typeof reference, "string", `${key} must be a string`);
    assert.ok(reference.trim(), `${key} must not be empty`);
    const placeholders = [...reference.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1]).sort();
    for (const catalog of catalogs.slice(1)) {
      const value = catalog.get(key);
      assert.equal(typeof value, "string", `${key} must be a string in every catalog`);
      assert.ok(value.trim(), `${key} must not be empty in any catalog`);
      assert.deepEqual(
        [...value.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1]).sort(),
        placeholders,
        `${key} must preserve interpolation placeholders`,
      );
    }
  }
});

test("catalog interpolation preserves dynamic article counts", async () => {
  assert.equal(typeof i18nModule.createReadFluxI18n, "function");
  const instance = i18nModule.createReadFluxI18n("fr");
  assert.equal(instance.t("feed.articleCount", { count: 2 }), "2 articles");
  assert.equal(instance.t("feed.articleCount", { count: 1 }), "1 article");
  assert.equal(instance.t("feed.markedRead", { count: 1 }), "1 article marqué comme lu");
  assert.equal(instance.t("feed.markedRead", { count: 2 }), "2 articles marqués comme lus");
});

test("manual refresh copy describes Miniflux synchronization", async () => {
  const catalogs = await Promise.all(["en", "zh-CN", "fr"].map(async (locale) =>
    JSON.parse(await readFile(new URL(`../src/locales/${locale}.json`, import.meta.url), "utf8"))));
  assert.deepEqual(catalogs.map((catalog) => catalog.sync.refresh), [
    "Sync with Miniflux",
    "与 Miniflux 同步",
    "Synchroniser avec Miniflux",
  ]);
  assert.equal(catalogs[0].sync.refreshDone, "Synced with Miniflux");
  assert.equal(catalogs[0].sync.refreshFailed, "Miniflux sync failed");
});

test("WebDAV settings describe device-scoped data synchronization", async () => {
  const catalogs = await Promise.all(["en", "zh-CN", "fr"].map(async (locale) =>
    JSON.parse(await readFile(new URL(`../src/locales/${locale}.json`, import.meta.url), "utf8"))));
  assert.deepEqual(catalogs.map((catalog) => catalog.webdav.title), [
    "WebDAV data sync",
    "WebDAV 数据同步",
    "Synchronisation des données WebDAV",
  ]);
  assert.equal(catalogs[1].webdav.disconnect, "断开此设备上的 WebDAV");
});

test("media loading labels describe the shared image and video policy", async () => {
  const chinese = JSON.parse(await readFile(new URL("../src/locales/zh-CN.json", import.meta.url), "utf8"));
  assert.equal(chinese.settings.imageDefault, "默认媒体加载方式");
  assert.equal(chinese.settings.imageLoading, "媒体加载方式");
  assert.match(chinese.settings.imageCompatibilityHint, /图片和视频/);
});

test("the React interface uses catalog keys instead of embedded Chinese copy", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(app, /useTranslation\(\)/);
  assert.match(main, /import "\.\/i18n"/);
  assert.doesNotMatch(app, /[\p{Script=Han}]/u);
  assert.doesNotMatch(html, /[\p{Script=Han}]/u);
  assert.doesNotMatch(app, />Entry ID<|>Feed ID<|>API Key<|>LOCAL-FIRST RSS</);
});

test("feed settings sort with the active interface language", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /localeCompare\([^,]+,\s*i18n\.resolvedLanguage\s*\?\?\s*"en"\)/);
  assert.doesNotMatch(app, /localeCompare\([^,]+,\s*"zh-CN"\)/);
});
