import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("GitHub Pages deployment uses the repository base path", async () => {
  const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /GITHUB_ACTIONS\s*\?\s*"\/ReadFlux\/"/);
});

test("the declared runtime targets the current Node LTS import syntax", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const i18n = await readFile(new URL("../src/i18n.ts", import.meta.url), "utf8");
  const deployment = await readFile(new URL("../.github/workflows/deploy-pages.yml", import.meta.url), "utf8");

  assert.equal(packageJson.engines.node, ">=24");
  assert.match(readme, /Node\.js 24 or later/);
  assert.match(i18n, /with \{ type: "json" \}/);
  assert.doesNotMatch(i18n, /assert \{ type: "json" \}/);
  assert.match(deployment, /node-version:\s*24/);
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
      client.minifluxFetch({ url: "https://rss.example", apiKey: "test" }, "/v1/me"),
      (error) => error instanceof client.MinifluxRequestError && error.status === 503,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
