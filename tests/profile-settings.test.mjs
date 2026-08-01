import assert from "node:assert/strict";
import test from "node:test";

const settingsModule = await import("../src/readflux-client.ts").catch(() => ({}));

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
