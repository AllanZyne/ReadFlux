import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("GitHub Pages deployment uses the repository base path", async () => {
  const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /GITHUB_ACTIONS\s*\?\s*"\/readflux\/"/);
});

test("no credential is embedded in source", async () => {
  const client = await readFile(new URL("../src/readflux-client.ts", import.meta.url), "utf8");
  assert.doesNotMatch(client, /X-Auth-Token["']?\s*:\s*["'][^"']+["']/);
  assert.doesNotMatch(client, /Authorization["']?\s*:\s*["']Basic\s+[A-Za-z0-9+/=]+/);
});
