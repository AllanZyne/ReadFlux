import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("GitHub Pages deployment uses the repository base path", async () => {
  const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /GITHUB_ACTIONS\s*\?\s*"\/ReadFlux\/"/);
});

test("no credential is embedded in source", async () => {
  const client = await readFile(new URL("../src/readflux-client.ts", import.meta.url), "utf8");
  assert.doesNotMatch(client, /X-Auth-Token["']?\s*:\s*["'][^"']+["']/);
  assert.doesNotMatch(client, /Authorization["']?\s*:\s*["']Basic\s+[A-Za-z0-9+/=]+/);
});

test("failed Miniflux requests expose a localizable status error", async () => {
  const client = await import("../src/readflux-client.ts");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 503 });
  try {
    await assert.rejects(
      client.minifluxFetch({ url: "https://rss.example", apiKey: "test", remember: false }, "/v1/me"),
      (error) => error instanceof client.MinifluxRequestError && error.status === 503,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
