import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const syncModule = await import("../src/webdav-sync.ts").catch(() => ({}));
const clientSource = await readFile(new URL("../src/readflux-client.ts", import.meta.url), "utf8");
const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

test("WebDAV PROPFIND responses expose collection names and ETags", () => {
  assert.equal(typeof syncModule.parseWebDavPropfind, "function");
  const entries = syncModule.parseWebDavPropfind(`<?xml version="1.0"?>
    <d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/readflux/v1/clients/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
      <d:response><d:href>/readflux/v1/clients/client-a/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getetag>&quot;abc&quot;</d:getetag></d:prop></d:propstat></d:response>
    </d:multistatus>`);
  assert.deepEqual(entries.map(({ name, etag, collection }) => ({ name, etag, collection })), [
    { name: "clients", etag: "", collection: true },
    { name: "client-a", etag: '"abc"', collection: true },
  ]);
});

test("recommendation sync uses client-owned monthly files and read-only remote mirrors", () => {
  assert.match(clientSource, /REMOTE_EVENTS\s*=\s*"remote-reading-events"/);
  assert.match(clientSource, /sourceMonth:\s*string/);
  assert.match(appSource, /recommendationEvents\s*=\s*useMemo\(\(\)\s*=>\s*\[\.\.\.events,\s*\.\.\.remoteEvents\]/);
  assert.match(appSource, /event\.remoteClientId[\s\S]*?remoteReadOnly/);
});

test("WebDAV settings support the agreed automatic intervals and manual sync", () => {
  assert.match(clientSource, /WebDavSyncInterval\s*=\s*0\s*\|\s*5\s*\|\s*15\s*\|\s*30\s*\|\s*60/);
  assert.match(appSource, /onSyncWebDav/);
  assert.match(appSource, /30_000/);
});
