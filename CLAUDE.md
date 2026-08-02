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

- `Today` contains unread Miniflux entries published on the current calendar
  day in the reader timezone and sorts them by the locally derived
  recommendation score.
- `All unread` contains every unread Miniflux entry and sorts them newest first.
- Recommendation scores affect ordering only and are not shown in the list.
- Reading an entry updates its live state without removing it from the current
  list snapshot.
- Rebuild read filters only when the user changes the list, toggles
  `Hide read`, marks the current list read, or refreshes data.
- `Saved` must be loaded from all paginated starred Miniflux results.
- Day and night are the only themes.
- Settings are an in-app dialog. Recommendation data is inspectable and raw
  events can be added, edited, or deleted.
- Category names, feed names, `Today`, `All unread`, and `Saved` use the same
  type size, weight, and row height. Hierarchy comes from disclosure controls,
  icons, and indentation.

## Architecture

- `src/App.tsx`: UI, Miniflux orchestration, list snapshots, reading tracker,
  and recommendation derivation.
- `src/readflux-client.ts`: browser persistence and Miniflux requests.
- `src/index.css`: all layout, themes, responsive behavior, and interaction
  states.
- `src/main.tsx`: React entry point.
- `src/i18n.ts`: i18next initialization, supported locale detection, and page metadata.
- `src/locales/*.json`: contributor-editable interface translation catalogs.
- `.github/workflows/deploy-pages.yml`: checks and GitHub Pages deployment.

Do not add a server, proxy, database, authentication service, or secret-bearing
build variable unless the user explicitly changes the architecture.

## Browser data

- Miniflux connection: localStorage or sessionStorage.
- Reading events, settings, cached entries, and sync progress: IndexedDB.
- Category and subscriptions-section collapse state: localStorage.

Never log, commit, upload, or add analytics around API keys, article contents,
or reading events.

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
- active foreground seconds
- maximum scroll depth
- entry path (`recommendation`, `feed`, `search`, or `saved`)
- optional explicit feedback

Current derivation rules:

- Interest contributions decay with a 28-day time scale.
- Very short events are ignored unless explicit positive feedback exists.
- Positive feedback gets a fixed strong contribution.
- Negative feedback contributes only to negative term weights.
- Starred entries add source and term affinity.
- Ranking combines source affinity, positive term matches, freshness, a starred
  bonus, and negative-term penalties, then clamps the internal score.

When changing ranking behavior:

1. Keep it deterministic and entirely local.
2. Update the Recommendation Data tab so the inputs and derived values remain
   inspectable.
3. Add focused tests for the new pure calculation where practical.
4. Update README and this file.
5. Do not surface the numeric score in the article list.

## Commands

```bash
npm run dev
npm run lint
npm test
npm run build
npm run preview
```

Run lint, tests, and build before publishing.

## Code conventions

- TypeScript strict mode is required.
- Prefer small typed functions and existing browser APIs.
- Keep state ownership in the narrowest component that needs it.
- Preserve optimistic Miniflux updates with rollback on request failure.
- Keep paginated entry loading for unread and starred views.
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
