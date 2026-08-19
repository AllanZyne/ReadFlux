import assert from "node:assert/strict";
import test from "node:test";

const settingsModule = await import("../src/readflux-client.ts").catch(() => ({}));

test("corrupted profile values do not trigger the legacy WebDAV migration", () => {
  assert.equal(typeof settingsModule.hasLegacyWebDavSettings, "function");
  assert.equal(settingsModule.hasLegacyWebDavSettings("corrupted"), false);
  assert.equal(settingsModule.hasLegacyWebDavSettings(null), false);
  assert.equal(settingsModule.hasLegacyWebDavSettings({ webdav: {} }), true);
  assert.deepEqual(settingsModule.normalizeProfileSettings("corrupted"), {
    theme: "day",
    showFeedArticleCount: false,
    markReadOnScroll: true,
    imageLoadingPreferences: {},
    incrementalSyncIntervalMinutes: 30,
    fullSyncIntervalMinutes: 240,
    updatedAt: new Date(0).toISOString(),
  });
});

test("legacy WebDAV credentials are removed when profile settings load", () => {
  assert.equal(typeof settingsModule.normalizeProfileSettings, "function");
  const normalized = settingsModule.normalizeProfileSettings({
    theme: "night",
    webdav: {
      url: "https://dav.example",
      username: "user",
      password: "secret",
      passphrase: "phrase",
    },
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(normalized, {
    theme: "night",
    showFeedArticleCount: false,
    markReadOnScroll: true,
    imageLoadingPreferences: {},
    incrementalSyncIntervalMinutes: 30,
    fullSyncIntervalMinutes: 240,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal("webdav" in normalized, false);
});

test("profile settings preserve only supported interface languages", () => {
  assert.equal(typeof settingsModule.normalizeProfileSettings, "function");
  assert.equal(settingsModule.normalizeProfileSettings({ language: "fr" }).language, "fr");
  assert.equal(settingsModule.normalizeProfileSettings({ language: "zh-CN" }).language, "zh-CN");
  assert.equal(settingsModule.normalizeProfileSettings({ language: "en" }).language, "en");
  assert.equal(settingsModule.normalizeProfileSettings({ language: "de" }).language, undefined);
  assert.equal("entryLookbackDays" in settingsModule.normalizeProfileSettings({ entryLookbackDays: 7 }), false);
});

test("feed article counts are hidden by default and accept only an explicit true value", () => {
  assert.equal(settingsModule.normalizeProfileSettings().showFeedArticleCount, false);
  assert.equal(settingsModule.normalizeProfileSettings({ showFeedArticleCount: true }).showFeedArticleCount, true);
  assert.equal(settingsModule.normalizeProfileSettings({ showFeedArticleCount: false }).showFeedArticleCount, false);
  assert.equal(settingsModule.normalizeProfileSettings({ showFeedArticleCount: "true" }).showFeedArticleCount, false);
});

test("scroll-to-read is enabled by default and disabled only by an explicit false value", () => {
  assert.equal(settingsModule.normalizeProfileSettings().markReadOnScroll, true);
  assert.equal(settingsModule.normalizeProfileSettings({ markReadOnScroll: true }).markReadOnScroll, true);
  assert.equal(settingsModule.normalizeProfileSettings({ markReadOnScroll: false }).markReadOnScroll, false);
  assert.equal(settingsModule.normalizeProfileSettings({ markReadOnScroll: 0 }).markReadOnScroll, true);
});

test("legacy origin-referrer feeds migrate to direct-origin overrides", () => {
  const normalized = settingsModule.normalizeProfileSettings({
    originReferrerFeeds: {
      "server-a": [7, 3],
    },
  });
  assert.deepEqual(normalized.imageLoadingPreferences, {
    "server-a": {
      defaultMode: "direct-no-referrer",
      feedModes: {
        3: "direct-origin",
        7: "direct-origin",
      },
    },
  });
  assert.equal("originReferrerFeeds" in normalized, false);
});

test("invalid image loading preferences are discarded", () => {
  const normalized = settingsModule.normalizeProfileSettings({
    imageLoadingPreferences: {
      valid: {
        defaultMode: "proxy",
        feedModes: { 3: "direct-origin", 4: "invalid" },
      },
      invalid: { defaultMode: "invalid", feedModes: {} },
    },
  });
  assert.deepEqual(normalized.imageLoadingPreferences, {
    valid: {
      defaultMode: "proxy",
      feedModes: { 3: "direct-origin" },
    },
  });
});

test("Miniflux sync intervals use supported values and requested defaults", () => {
  const defaults = settingsModule.normalizeProfileSettings();
  assert.equal(defaults.incrementalSyncIntervalMinutes, 30);
  assert.equal(defaults.fullSyncIntervalMinutes, 240);

  const manual = settingsModule.normalizeProfileSettings({
    incrementalSyncIntervalMinutes: 0,
    fullSyncIntervalMinutes: 480,
  });
  assert.equal(manual.incrementalSyncIntervalMinutes, 0);
  assert.equal(manual.fullSyncIntervalMinutes, 480);

  const invalid = settingsModule.normalizeProfileSettings({
    incrementalSyncIntervalMinutes: 5,
    fullSyncIntervalMinutes: 1440,
  });
  assert.equal(invalid.incrementalSyncIntervalMinutes, 30);
  assert.equal(invalid.fullSyncIntervalMinutes, 240);
});
