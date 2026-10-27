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
- **Read later** keeps any article you tag, and links you save from articles,
  until you remove the tag
- An **Unread only** list filter replaces a separate unread destination
- Saved articles, source-scoped subscription groups, feed icons, and dynamic
  counts
- IndexedDB article cache, cache-first startup, and scheduled incremental sync
- Initial sync prioritizes unread articles, then all saved articles, then read
  articles, with paginated progress
- Full article history is cached locally through resumable paginated sync
- Stable list snapshots, so articles do not disappear while being read
- Read and saved state updates immediately; recommendation scores and ordering
  are recalculated when the list is refreshed or its context changes
- GitHub Pages-safe article permalinks using `#/article/:entryId`
- Day and night themes
- English, Simplified Chinese, and French interfaces selectable in Settings
- Per-server and per-feed image loading choices for original images with or
  without an Origin referrer, plus Miniflux proxy links when the server exposes them
- Continuous keyboard reading, adjustable column widths, and mobile navigation
- Inspection, editing, and deletion of reading events, feed preferences, and
  keyword preferences
- Optional AI summaries and translations through your own OpenAI-compatible or
  Anthropic provider, saved locally per article

## Privacy and security

ReadFlux has no application server:

- The Miniflux URL, API key, timezone, and preferences are stored only in
  this browser's `localStorage`.
- Article content, article state, Updated and Read later labels, feed
  metadata, sync state, reading events, ranking exposures, and pending Miniflux
  writes are stored in IndexedDB.
- The browser sends requests directly to your Miniflux server.
- The repository and build output contain no credentials.
- Article text leaves the browser only when you click **Summarize** or
  **Translate**, and only to the AI provider you configured. See
  [AI summaries and translations](#ai-summaries-and-translations).

On a shared computer, leave **Remember on this device** unchecked. Create a
dedicated Miniflux API key for ReadFlux so it can be revoked independently.

## Requirements

- Node.js 24 or later
- Miniflux 2.3.2 or later, accessible over HTTPS
- Miniflux, or its reverse proxy, configured to allow requests from the
  ReadFlux origin
- CORS rules that allow `X-Auth-Token`, `Content-Type`, and the `GET`, `PUT`,
  `POST`, and `OPTIONS` methods used by ReadFlux

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

## Read later

The bookmark button in the reader toolbar tags the open article for **Read
later**. **Read later** lists every tagged article, read or unread, with the
most recently tagged first. An article stays there until you remove the tag;
reading it does not remove it. Tagged articles keep their place in **Today**,
**All**, and the other lists.

A tagged article ends with a choice: **Save** stars it and removes it from
**Read later**, and **Remove** only removes it. Either way, the next article
in **Read later** opens, or the article closes when it was the last one. The
notice that follows offers **Undo**.

Clicking or tapping a link in an article opens a menu: **Read later**, **Open
link**, and **Copy link**, plus **Open in ReadFlux** when the link is already a
synced article. Ctrl/⌘-, Shift-, and middle-clicks open the link directly.

**Read later** on a link that is already a synced article tags that article.
Any other link is added to Miniflux as an unread article, and Miniflux fetches
the page's content. Saved links appear only in **Read later**, and in **Saved**
if you star them. After you remove the tag from a link you have not starred,
it no longer appears anywhere, and Miniflux deletes it after its cleanup period
(60 days by default).

Tags are stored only in this browser and are not synced to other devices.
On another device, links you saved appear only if you starred them.

The first saved link creates a disabled feed named **ReadFlux · Read later**
in a category of the same name. The feed points at the empty
`readflux-read-later.xml` file published with ReadFlux, and Miniflux fetches it
once when the feed is created. ReadFlux hides this feed and category from
**Subscriptions**. Open ReadFlux from its published address for the first
save; a local development server is not reachable from Miniflux.

The link goes only to your Miniflux server. Miniflux then requests the page
itself, as it does for feed articles.

## Recommendation data

ReadFlux records the article, feed, title, keywords, open time, active
foreground time, scroll depth, and entry path. Saved state remains managed by
Miniflux. There are no like or dislike buttons: articles you skip, scroll past,
or leave quickly already count against their feed.

Foreground time counts only while the page is visible and focused and no
dialog is open, and only while the mouse is over the article or its card in
the article list, or one of the article's videos is fullscreen.

**Today** ranks articles within each publication-time and read-status group
using the feeds you read, the topics you follow, publication time, and saved
state, with more weight on recent behavior. Topics you follow count more when
you read articles about them. ReadFlux never learns topics you did not follow.

The end of each article explains why it is where it is, with the full score
breakdown. Scores are not shown in the article list. A link saved for later
is not ranked and ends only with the **Read later** choice. The Read later tag
does not affect ranking.

The **Recommendation data** tab in Settings shows the derived feed and topic
weights and the 30 most recent raw events by default. Local records can be
edited or deleted, and search still covers the complete event history.

**Export JSON** in the same tab downloads an unencrypted local file. It
contains all local and mirrored reading events, ranking
exposures, the derived profile, diagnostics, feed and category names, and
metadata for referenced, unread, updated, and saved articles: title, URL,
publication time, state, the title-plus-excerpt text used for scoring, and the
current score breakdown. It never includes full article content or Miniflux and
WebDAV credentials. When WebDAV is configured, the tab shows its sync status and
disables export while a sync is running.

Each **Today** list also records its top 100 articles and which of them you
saw.

Candidate topics appear as hashtags after the article's byline. Topics you
already follow are highlighted; click a hashtag to follow it, or click a
highlighted one to stop following it everywhere.

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

## AI summaries and translations

Configure an AI provider in **Settings → AI** to enable two controls under the
article byline:

- An **Original | <language>** switch. Choosing the language translates the
  article body in place, paragraph by paragraph as the reply streams in, with
  untranslated paragraphs dimmed and a translated-paragraph count. Choose
  **Original** to return to the original text or to cancel a running
  translation. Links, emphasis, images, and code are preserved; only text is
  sent for translation.
- **Summarize** shows a short bulleted summary above the article.

Both use the target language from **Settings → AI → Translation**, which
defaults to the interface language. Results are saved in IndexedDB per article,
task, and language, so clicking again shows the saved result. Reopening an
article shows its saved summary or translation again unless you hid it last
time. A result is generated again when the article content changes. Ctrl+click (⌘+click on macOS),
or Ctrl/⌘+Enter on the focused button, regenerates and replaces it.

Two provider types are supported:

- **OpenAI-compatible**: any `/chat/completions` endpoint, such as OpenAI,
  OpenRouter, DeepSeek, Ollama, or LM Studio. The API key is optional for local
  servers. Reasoning that some models inline as `<think>` or `<reasoning>` is
  hidden.
- **Anthropic**: the Messages API, called with Anthropic's direct browser access
  header.

Enter the fields in order: provider, base URL, API key, then model. **Load
models** fills model suggestions from the provider's models endpoint when it
has one; otherwise type the model name. **Reasoning effort** defaults to the
provider's own default. Low, Medium, or High is sent as `reasoning_effort` to
OpenAI-compatible endpoints, which only reasoning models accept, and as
`output_config.effort` to Claude 5 models. **Test connection** and **Save**
report their result directly in the AI tab.

The browser calls the provider directly, so the provider must accept
cross-origin browser requests, including the CORS preflight for the
`Authorization` or `x-api-key` header. Local servers must allow the ReadFlux
origin (for Ollama, set `OLLAMA_ORIGINS`). Some gateways answer requests from
`curl` but reject browser preflights; the Amazon Bedrock OpenAI-compatible
endpoint is one example, and ReadFlux reports a network/CORS error for it.

When you click Summarize or Translate, the article title and text are sent to
the configured provider. Nothing is sent automatically. Reading events,
recommendation data, and Miniflux credentials are never sent. The provider
settings, including the API key, are stored unencrypted in `localStorage`.
Disconnecting removes them and all saved results from the browser. AI settings
and results are not included in the recommendation export.

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
