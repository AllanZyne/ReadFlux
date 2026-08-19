# ReadFlux

ReadFlux is a static, local-first Miniflux client. It uses Miniflux as the
source for feeds and articles, records real reading behavior in the browser,
and turns unread or newly updated articles into a personalized **Today** view.
The complete synced history remains available in **All**.

## Features

- NetNewsWire-inspired three-column reading interface
- **Today** contains unread articles and previously read articles with new
  updates, ordered by time period, unread status, and local recommendations
- **All** contains the complete synced history in reverse publication order
- **Updated** tracks previously read articles whose content changed since they
  were last opened
- An **Unread only** list filter replaces a separate unread destination
- Saved articles, source-scoped subscription groups, feed icons, and dynamic
  counts
- IndexedDB article cache, cache-first startup, and scheduled incremental sync
- Initial sync prioritizes unread articles, then all saved articles, then read
  articles, with paginated progress
- Full article history is cached locally through resumable paginated sync
- Stable list snapshots, so articles do not disappear while being read
- GitHub Pages-safe article permalinks using `#/article/:entryId`
- Day and night themes
- English, Simplified Chinese, and French interfaces selectable in Settings
- Per-server and per-feed image loading choices for original images with or
  without an Origin referrer, plus Miniflux proxy links when the server exposes them
- Continuous keyboard reading, adjustable column widths, and mobile navigation
- Inspection, editing, and deletion of reading events, feed preferences, and
  keyword preferences

## Privacy and security

ReadFlux has no application server:

- The Miniflux URL and API key are stored only in the current browser's
  `localStorage` or `sessionStorage`.
- Reading events and recommendation settings are stored in IndexedDB.
- The browser sends requests directly to your Miniflux server.
- The repository and build output contain no credentials.

On a shared computer, leave **Remember on this device** unchecked. Create a
dedicated Miniflux API key for ReadFlux so it can be revoked independently.

## Requirements

- Node.js 24 or later
- Miniflux 2.3.2 or later, accessible over HTTPS
- Miniflux, or its reverse proxy, configured to allow requests from the
  ReadFlux origin
- CORS rules that allow `X-Auth-Token`, `Content-Type`, and the `GET`, `PUT`,
  and `OPTIONS` methods used by ReadFlux

Miniflux recommends a separate API key for each application. ReadFlux sends the
key in the `X-Auth-Token` header.

## Local development

```bash
npm install
npm run dev
```

Open the local address shown in the terminal, then enter your Miniflux URL and
dedicated API key.

Run these checks before submitting changes:

```bash
npm run lint
npm test
npm run build
```

## Contributing translations

ReadFlux uses `i18next` and separate JSON locale files. To improve an existing
translation, edit the corresponding file under `src/locales/`; automated tests
verify that every locale has the complete key set and preserves interpolation
placeholders.

See [CONTRIBUTING.md](CONTRIBUTING.md) for adding a language, working with
placeholders and plurals, and submitting changes through GitHub's web editor.
No React changes are needed for ordinary translation fixes.

## Deploying to GitHub Pages

The repository includes `.github/workflows/deploy-pages.yml`. After a push to
`main`, the workflow:

1. Installs dependencies.
2. Runs lint, tests, and the production build.
3. Deploys `dist/` to GitHub Pages.

For the first deployment, open **Settings → Pages → Build and deployment** in
the GitHub repository and set **Source** to **GitHub Actions**. The default URL
is:

```text
https://allanzayne.github.io/readflux/
```

If a fork uses a different repository name, update the GitHub Pages base path
in `vite.config.ts`.

## Recommendation data

ReadFlux records the article, feed, title, keywords, open time, active
foreground time, scroll depth, entry path, and explicit **Helpful** or
**Not interested** feedback. Saved state remains managed by Miniflux.

The recommendation profile gives more weight to recent behavior and combines:

- Feed affinity
- Explicitly followed topics selected from candidates, article titles, or article text; each topic has a fixed weight of 1 even when selected repeatedly
- Publication time
- Saved articles
- Negative keywords

Recommendation scores order articles within each **Today** time and read-status
tier and are not displayed in the article list. The **Recommendation data** tab
in Settings exposes derived weights and the 30 most recent raw events by
default. Local records can be edited or deleted, and search still covers the
complete event history.

When an article is opened, followed topics found in its title or summary are
prioritized in the five candidate-topic slots. Chinese topics use substring
matching, while Latin-script words and phrases require complete word boundaries;
the remaining slots are filled by the normal Jieba and technical-term extractor.

### Optional WebDAV sync

ReadFlux can synchronize recommendation events between ReadFlux installations
through a user-provided WebDAV directory. Each installation owns a client
folder under `v1/clients/` and stores authoritative monthly event files under
`events/YYYY-MM.json`. Clients read other folders as read-only mirrors and
combine those events locally; there is no shared manifest or profile file.

Configure the dedicated WebDAV directory, Basic Auth credentials, client name,
and pull interval in **Settings → Sync**. Existing local events are uploaded on
first connection. Later local changes upload after a short delay, while remote
pulls run at startup, on foreground resume, at the selected interval, or from
the **Sync now** button. WebDAV sync requires browser CORS support for `MKCOL`,
`PROPFIND`, `GET`, and `PUT`. Credentials and remote JSON are not encrypted by
ReadFlux.

## Technology

- React
- TypeScript
- Vite
- i18next and react-i18next
- Miniflux REST API
- WebDAV for optional recommendation-event sync
- IndexedDB and Web Crypto API

## License

[MIT](LICENSE)
