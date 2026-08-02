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
    originReferrerFeeds: {},
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
    originReferrerFeeds: {},
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
