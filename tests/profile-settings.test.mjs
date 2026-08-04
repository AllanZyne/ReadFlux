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
    entryLookbackDays: 30,
    imageLoadingPreferences: {},
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
    entryLookbackDays: 30,
    imageLoadingPreferences: {},
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
