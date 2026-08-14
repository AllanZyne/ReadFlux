import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const syncModule = await import("../src/webdav-sync.ts").catch(() => ({}));
const syncSource = await readFile(new URL("../src/webdav-sync.ts", import.meta.url), "utf8");
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

test("WebDAV PROPFIND excludes the requested collection's self response", () => {
  const entries = syncModule.parseWebDavPropfind(`<?xml version="1.0"?>
    <d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/readflux/v1/clients/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
      <d:response><d:href>/readflux/v1/clients/client-a/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
    </d:multistatus>`, "https://dav.example/readflux/v1/clients/");
  assert.deepEqual(entries.map(({ name }) => name), ["client-a"]);
});

test("WebDAV connection identity includes the username and normalizes trailing slashes", () => {
  assert.equal(typeof syncModule.webDavConnectionIdentity, "function");
  assert.equal(
    syncModule.webDavConnectionIdentity({ url: "https://dav.example/readflux///", username: "alice" }),
    "https://dav.example/readflux/\nalice",
  );
  assert.notEqual(
    syncModule.webDavConnectionIdentity({ url: "https://dav.example/readflux", username: "alice" }),
    syncModule.webDavConnectionIdentity({ url: "https://dav.example/readflux", username: "bob" }),
  );
  assert.match(appSource, /webDavConnectionIdentity\(webDavConfig\)\s*!==\s*webDavConnectionIdentity\(next\)/);
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

test("WebDAV connection checks and syncs share serialization without UI lock resets", () => {
  assert.match(syncModule.testWebDavConnection.toString(), /serialize/);
  assert.doesNotMatch(appSource, /webDavSyncInFlight/);
});

test("WebDAV upload claims dirty months before snapshotting and restores unfinished months", () => {
  const upload = syncModule.synchronizeWebDav.toString();
  assert.match(clientSource, /export async function claimDirtyReadingEventMonths/);
  assert.match(clientSource, /store\.put\(\[\], WEBDAV_DIRTY_MONTHS\)/);
  assert.match(clientSource, /export async function markReadingEventMonthsDirty/);
  assert.match(upload, /serialize/);
  const claimAt = syncSource.indexOf("await claimDirtyReadingEventMonths()");
  const snapshotAt = syncSource.indexOf("await getReadingEvents()", claimAt);
  const restoreAt = syncSource.indexOf("markReadingEventMonthsDirty(dirtyMonths.slice(uploaded))", snapshotAt);
  assert.ok(claimAt >= 0 && snapshotAt > claimAt && restoreAt > snapshotAt);
  assert.doesNotMatch(syncSource.slice(claimAt, restoreAt), /clearDirtyReadingEventMonth/);
});
