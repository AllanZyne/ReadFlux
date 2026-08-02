# ReadFlux

ReadFlux is a static, local-first Miniflux client. It uses Miniflux as the
source for feeds and articles, records real reading behavior in the browser,
and ranks unread articles published today into a personalized **Today** view.

## Features

- NetNewsWire-inspired three-column reading interface
- **Today** contains unread articles published on the current local day, ranked
  by local recommendations
- **All unread** contains every unread article, sorted newest first
- Saved articles, subscription groups, feed icons, and unread counts
- IndexedDB article cache, cache-first startup, and scheduled incremental sync
- Initial sync prioritizes unread articles, then all saved articles, then read
  articles, with paginated progress
- Ordinary articles load from the latest 30 days by default, with an adjustable
  range during first connection and in Settings; saved articles are unlimited
- Stable unread-list snapshots, so articles do not disappear while being read
- Day and night themes
- English, Simplified Chinese, and French interfaces selectable in Settings
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
- A Miniflux instance accessible over HTTPS
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
- Interest keywords from titles and article summaries
- Publication time
- Saved articles
- Negative keywords

Recommendation scores only order **Today** and are not displayed in the article
list. The **Recommendation data** tab in Settings exposes derived weights and
raw events and allows records to be added, edited, or deleted.

## Technology

- React
- TypeScript
- Vite
- i18next and react-i18next
- Miniflux REST API
- IndexedDB and Web Crypto API

## License

[MIT](LICENSE)
