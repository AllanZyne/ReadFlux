# CLAUDE.md

This file gives coding agents the project context and constraints needed to
work safely on ReadFlux.

Detailed rationale and reusable implementation checklists live in
[`docs/development-bkms.md`](docs/development-bkms.md). Files under
`docs/superpowers/` are temporary working artifacts and must never be
committed.

## Product

ReadFlux is a static, local-first Miniflux client. It has no application
backend. The browser talks directly to Miniflux.

The primary product contract is:

- `Today` contains unread entries plus previously read entries carrying the
  `updated` label. It sorts by publication-time tier (`today`, `yesterday`,
  `this week`, `this month`, `this year`, then older), then unread status,
  local recommendation score, and publication time.
- `All` contains the complete synced Miniflux history and sorts strictly by
  publication time, newest first.
- `Updated` contains previously read entries whose content changed after they
  were cached, and clears an entry's update label when it is reopened.
- `Read later` contains every entry carrying the local `later` label, read or
  not, newest label first. Any article can be tagged from the reader toolbar,
  and a link in an article from its link menu. The only way out is removing
  the tag; reading never removes it. Tagging does not move an article out of
  the other smart feeds.
- Links saved from articles are entries of the hidden Read later feed. They
  appear only in `Read later` while tagged and in `Saved` while starred, never
  in `Today`, `All`, or `Updated`. Miniflux has no API to delete an entry, so
  an untagged, unstarred link stays hidden until Miniflux's cleanup deletes it.
- `Unread only` is a list filter, not a separate smart feed. It does not apply
  to `Updated`, whose entries are already read by definition, or to
  `Read later`, which keeps tagged entries whatever their status.
- Recommendation scores affect ordering within each `Today` time and read-status
  tier only, and are not shown in the list. The end of the open article shows
  its sort keys and every score component with its formula and inputs. A saved
  link is not ranked and has no score breakdown. The `later` label does not
  affect ranking.
- In `Read later`, each entry ends with the Read later ticket: save it (star
  it and remove the tag) or remove the tag, and either way open the next entry
  in the list on screen, or close the article when it was the last. The ticket
  previews only that next entry, not how long this one waited. The toast's
  undo restores the tag and star and reopens the entry. Other smart feeds show
  no ticket; the reader toolbar still adds and removes the tag.
- There are no explicit like or dislike controls. Skipping, scrolling past,
  and quickly leaving an article are the negative signals.
- Reading an entry updates its live state without removing it from the current
  list snapshot. Reuse recommendation scores and reasons until the next list
  refresh or context change; scroll-to-read must not rescore existing articles.
- Rebuild read filters only when the user changes the list, toggles
  `Unread only`, marks the current list read, or refreshes data. Midnight score
  decay must not rebuild the captured list or its read-status snapshot.
- `Saved` must be loaded from all paginated starred Miniflux results.
- Category and feed selection filters the current smart feed. Switching smart
  feeds preserves that source scope and closes the current article; selecting
  the active smart feed again clears the source scope. `Read later` applies it
  like `Saved`; saved links have no subscription row, so they show only
  without a scope.
- Day and night are the only themes.
- Settings are an in-app dialog. Recommendation data is inspectable, raw
  events can be added, edited, or deleted, and the tab can export a local JSON
  file for offline evaluation. The export omits full article content and all
  credentials.
- The reader can summarize or translate the open article with the user's own AI
  provider. Clicking a button again reuses the saved result.
- Category names, feed names, `Today`, `All`, `Updated`, `Saved`, and
  `Read later` use the same type size, weight, and row height. Hierarchy comes from disclosure controls, icons,
  and indentation.

## Architecture

- `src/App.tsx`: UI, Miniflux orchestration, list snapshots, reading tracker,
  and recommendation derivation.
- `src/readflux-client.ts`: browser persistence and Miniflux requests.
- `src/ai-client.ts`: AI provider requests, streaming, prompts, and pure
  translation segment helpers.
- `src/ai-translation.ts`: DOM block extraction and placeholder restoration for
  translations.
- `src/article-ai.ts`: per-article summary and translation state, saved-result
  reuse, and cancellation.
- `src/entry-labels.ts`: the local `updated` and `later` entry labels and pure
  helpers to change and compare them.
- `src/read-later.ts`: Read later feed discovery and creation, entry import,
  and pure link URL and title helpers.
- `public/readflux-read-later.xml`: the empty Atom file the Read later feed
  points at.
- `src/index.css`: all layout, themes, responsive behavior, and interaction
  states.
- `src/main.tsx`: React entry point.
- `src/i18n.ts`: i18next initialization, supported locale detection, and page metadata.
- `src/locales/*.json`: contributor-editable interface translation catalogs.
- `.github/workflows/deploy-pages.yml`: checks and GitHub Pages deployment.

Do not add a server, proxy, database, authentication service, or secret-bearing
build variable unless the user explicitly changes the architecture.

## Browser data

- Miniflux connection and preferences: localStorage.
- Local reading events, read-only remote event mirrors, article content and
  state, feed metadata, sync progress, and the Miniflux outbox: IndexedDB.
- Entry labels: IndexedDB `labels`, one record per entry and label with the
  time it was added. `updated` is derived from synced content: reopening or
  marking the entry read clears it, and resetting sync deletes it. `later`
  belongs to the user: only removing the tag clears it, resetting sync keeps
  it, and it is neither sent to Miniflux nor synced through WebDAV.
- Optional WebDAV connection and stable client identity: localStorage.
- Category and subscriptions-section collapse state: localStorage.
- Optional AI provider connection: localStorage. Saved AI summaries and
  translations: IndexedDB `ai-results`.

Never log, commit, upload, or add analytics around API keys, article contents,
or reading events. The only exception is the explicit AI action below.

## AI summaries and translations

- AI is optional and browser-to-provider. Supported providers are
  OpenAI-compatible `/chat/completions` endpoints and the Anthropic Messages
  API. Do not add a proxy to work around provider CORS limits.
- An article's title and text are sent only when the user clicks Summarize or
  Translate, and only to the configured provider. Never send articles
  automatically, and never send reading events, recommendation data, or
  Miniflux credentials.
- Results are saved per entry, task, and target language with a hash of the
  title and content. A changed article generates a new result. Ctrl/⌘+click or
  Ctrl/⌘+Enter forces regeneration.
- A saved result records whether it was showing. Reopening the article shows a
  saved summary or translation again unless the user last hid it; this reads
  IndexedDB only and never contacts the provider.
- Summaries render as plain text. Translations send block text with inline
  markup replaced by numbered placeholders, are rebuilt from the original
  nodes, and always render through the article sanitizer.
- AI output does not affect recommendations, reading events, or topic terms.
  Text selection on a translated body does not propose topics.
- The target language is a profile preference that defaults to the interface
  language. Disconnecting clears the provider settings and saved results.
- Reasoning effort is optional provider configuration. When unset, send no
  effort parameter.
- AI settings feedback (test, save, model loading, clearing results) appears
  inline in the AI tab, not as toasts.
- The provider API key is intentionally unencrypted. Keep that boundary
  explicit in the UI and documentation.

## Read later

- The Read later tag is the local `later` entry label. Miniflux cannot set
  tags on an existing entry, so the tag stays in this browser; another device
  sees saved links only as starred entries in `Saved`.
- A link that matches a synced entry tags that entry instead of importing a
  copy, preferring an entry already tagged, then a subscribed one.
- Other links become Miniflux entries, imported with
  `POST /v1/feeds/{id}/entries/import` (Miniflux 2.2.16 or later) into one
  feed and then tagged; `fetch-content` asks Miniflux to scrape the page.
  Always send `status: "unread"`; Miniflux imports as read by default.
- The Read later feed is identified by its feed URL ending in
  `/readflux-read-later.xml`, never by a title or a stored ID, so every device
  and deployment finds the same feed. ReadFlux creates it on the first save,
  disabled, in the `ReadFlux · Read later` category. Miniflux must fetch the
  file once at creation, so a dev server cannot create it.
- Hide the feed, and a category that holds only it, from Subscriptions. Saved
  links show their site as the source and no feed icon.
- A plain click or tap on an article link opens the link menu; modified and
  middle clicks keep browser behavior. Enter on a focused link opens the menu
  and must not trigger the reader's open-original shortcut.
- Link actions and imports keep the URL fragment, which can name a section
  or a hash route; only matching a link to synced entries ignores it.
- Titles come from the link: its text unless that only describes the action
  ("read more", "原文"), then its `title`, then a linked image's `alt`, then the
  host and last path segment. A translated body takes the original link text.
- The feed a link was saved from is stored as a `via <source>` Miniflux tag,
  the only metadata an import can carry, and shown on the Read later ticket.
- Miniflux keeps tombstones for entries its cleanup deleted. Importing such a
  link again retries with a fresh `external_id`.
- The link goes only to the user's Miniflux. Do not fetch the page from the
  browser or through a third-party service to get a title.

## WebDAV recommendation sync

- WebDAV is optional and browser-to-server; no application backend or proxy is
  part of the architecture.
- The configured URL is a dedicated ReadFlux directory. Data lives under
  `v1/clients/<client-id>/`, with one authoritative `events/YYYY-MM.json` file
  per UTC month.
- A client writes only its own folder. Events from other folders are read-only
  local mirrors and must not become editable through the Recommendation Data
  tab.
- Do not add a shared manifest or profile file. Discover clients and monthly
  files with `PROPFIND`, and use ETags to avoid unchanged downloads.
- Local changes upload after a short debounce. Remote pulls happen only while
  the page is open and must not reorder the currently captured Today list.
- Disconnecting clears credentials and remote mirrors locally but leaves the
  server folder intact.
- WebDAV credentials and event JSON are intentionally unencrypted. Keep that
  boundary explicit in the UI and documentation.

## Timezone

Use one timezone throughout the reader: the Miniflux account timezone, falling
back to the browser timezone when unavailable. Use shared helpers for all date
display and calendar logic; never mix in the device timezone. Store timestamps
in UTC, keep absolute-time calculations unchanged, and show the active timezone
in Sync settings.

## Recommendation behavior

An event records:

- entry and feed identifiers
- title, source, and extracted terms
- opened time
- active foreground seconds, accumulated from real elapsed time while the page
  is visible and focused, no modal is open, and the mouse is over the reader
  or the open article's list card (so a short article read in full from the
  list still counts), or an article video is fullscreen. Moving the mouse
  elsewhere, out of the window, or scrolling the card out from under it,
  including with list keys, pauses it. Opening an article, pressing a key in
  the reader (captured before its controls), or scrolling it with Space
  resumes it until the mouse next acts. Leaving fullscreen rechecks the
  element under the mouse, or restores the earlier state when no mouse
  position is known. Touch has no hover, so only a tap moves attention.
  Events from older versions are quantized to 5-second steps.
- maximum scroll depth
- the entry's Miniflux reading time, when available
- entry path (`recommendation`, `feed`, `search`, or `saved`)

Events from older versions may carry explicit `helpful` or `not_interested`
feedback. It is kept as stored data but no longer read or shown.

Today exposures record the top 100 items: entry, rank, score components, and,
for new records, the feed ID and publication time. Older items without a feed
ID fall back to cached entries. New exposures also record `seenEntryIds`:
items at least half visible in the article list for 0.5 seconds while the page
is visible. This does not depend on the mark-read-on-scroll setting.

Current derivation rules:

- Event and exposure contributions decay with a 28-day time scale.
- Each event's reading quality is foreground time divided by its reading time
  (at least one minute), capped at 1. Scroll depth counts in proportion to
  reading time, reaching full credit at 10 minutes.
- Events under 5 seconds with little length-adjusted scroll have zero quality.
  They still count as reads, which lowers the feed's average depth.
- There is no explicit feedback: a skipped, scrolled-past, or quickly left
  article is the negative signal, through zero quality and the seen open rate.
  Exposure items keep a `negativePenalty` of 0, because older clients reject
  synced exposures without it.
- Starred entries add `log1p(count)` pseudo-reads of full quality to their
  feed. A star decays from `starredAt` when a reading event recorded one.
  Starred entries add no term affinity.
- Feed affinity is smoothed engagement (3-read prior) multiplied by a smoothed
  Today open rate (20-impression prior). In exposures with `seenEntryIds`,
  each seen or opened item is one impression, so seen-but-skipped items lower
  the feed's open rate. Older exposures weight every item by
  `1 / log2(rank + 1)`. An open is an attributed event with `rankingId` and
  `exposedRank`. Until any attributed open exists, every feed's open rate is a
  neutral 1, and the average-depth baseline never drops below 0.01, so depth
  and saved-article differences still rank feeds. The result is divided by the average feed's value, and
  the source score is `20 * r / (1 + r)`. A feed with no data scores 10, and
  every feed scores 0 before any profile data exists.
- A topic is followed when its most recent explicit follow or unfollow, across
  all articles and synced devices, is a follow. The reader highlights followed
  topics wherever they appear as candidates. Only followed topics get weight;
  other terms are never learned from reading.
- Topic affinity mirrors feed affinity over the articles that mention the
  topic (its extracted terms, or a match in the title-plus-summary text):
  smoothed depth (3-read prior) times smoothed Today open rate (20-impression
  prior), divided by the average-article baseline. A topic's weight is
  `2 * r / (1 + r)`: 1 without data, toward 2 for topics read more than
  average, below 1 for topics that are opened without reading or seen and
  skipped.
- The topic score is `12 * (1 - exp(-Σ weight / 2.2))`, so one neutral topic
  adds about 4.4 and several strong topics reach 12. The cap stays below the
  source score's 20: offline evaluation of an October 2026 export showed feed
  affinity predicts engaged and deep reads best, and caps of 16 or more lowered
  them, most in recent exposures. Re-evaluate before raising it.
- Ranking adds a base of 40 to the topic, source, freshness, and starred
  components, then clamps the internal score.

When changing ranking behavior:

1. Keep it deterministic and entirely local.
2. Update the Recommendation Data tab so the inputs and derived values remain
   inspectable.
3. Add focused tests for the new pure calculation where practical.
4. Update this file. Keep the README to what users notice (what is recorded,
   what influences Today, where to inspect it); formulas, weights, and
   evaluation belong here.
5. Do not surface the numeric score in the article list.
6. Compare the change offline as described below. Never commit exports or
   evaluation output.

### Offline evaluation

The user exports data from Settings → Recommendation data → Export JSON and
provides the file path. Keep the file outside the repository and pass it only
as an argument.

- `npm run eval -- <export.json>` replays each recorded Today list with only
  the data from before it and prints pairwise AUC within the same exposure,
  read status, and publication day for opens, engaged reads, and reads of 30
  seconds or more. `--since YYYY-MM-DD` scores only exposures from that date,
  while earlier data still builds the replayed profiles; use it when the user
  reports that recent ranking feels worse. `--json` prints the full result.
- Run it on the change and on the base. For the base, create a temporary
  detached worktree of the base commit outside the repository, link the main
  `node_modules` into it as a junction, and run
  `node scripts/evaluate-recommendations.mjs <export.json>` there. When
  cleaning up, remove the junction by itself first (`cmd /c rmdir`) so nothing
  deletes through it into the real `node_modules`, then
  `git worktree remove --force` and `git worktree prune`.
- Compare the `replayed` columns between runs, and the per-component columns
  (`replayed source`, `replayed term`) to see which signal moved. The
  `recorded` column shaped the on-screen order, so its open AUC is inflated by
  position bias; it is still useful as the quality the user actually saw.
- Engaged and deep reads matter more than opens. Prefer a change that raises
  them, overall and in recent exposures, even at a small cost in opens.
- To tune a constant, sweep a few values with temporary edits, run `--json`
  for each, and restore the file afterwards. Record the chosen value's
  rationale in a code comment and in the ranking rules above, without raw
  numbers.

## Commands

```bash
npm run dev
npm run lint
npm test
npm run build
npm run preview
npm run eval -- <readflux-recommendation-export.json> [--since YYYY-MM-DD] [--json]
```

Run lint, tests, and build before publishing.

## Code conventions

- TypeScript strict mode is required.
- Prefer small typed functions and existing browser APIs.
- Keep state ownership in the narrowest component that needs it.
- Preserve optimistic Miniflux updates with rollback on request failure.
- Keep paginated entry loading for the unread, starred, and read sync phases.
- Sanitize feed HTML before using `dangerouslySetInnerHTML`.
- Preserve keyboard and mobile behavior when changing desktop layout.
- Use Miniflux category and feed IDs for identity; titles are display text only.
- Avoid adding dependencies when a browser API or short local helper is enough.
- Use Bootstrap Icons for interface icons instead of Unicode approximations.
- Apply hover and selected states to the complete interactive row, including
  its icon, label, and count.
- Keep disclosure and selection as separate controls and semantics. Expose
  state with appropriate `aria-expanded`, `aria-current`, and accessible
  labels.
- Check UI changes in day and night themes, desktop and mobile layouts, and
  keyboard and focus-visible interactions.
- Keep user-facing interface copy in the locale catalogs, preserve interpolation
  placeholders, and keep all locale key sets identical.

## Deployment

The production build is a static Vite artifact in `dist/`. GitHub Actions
deploys that directory to the `/readflux/` GitHub Pages base path. If the
repository name changes, update the base path in `vite.config.ts`.

Do not commit `dist/`, credentials, `.env` files, or local browser exports.
