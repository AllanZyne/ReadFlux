# ReadFlux Development BKMs

This handbook records best known methods that are already demonstrated by the
ReadFlux codebase or by an accepted regression fix. `CLAUDE.md` remains the
source of mandatory product and architecture constraints; this document
explains how to apply those constraints consistently.

## Maintaining this handbook

- Promote a practice to a BKM only after it is supported by current code or a
  resolved defect.
- Treat requirements in `CLAUDE.md` as mandatory. Treat guidance here as the
  default approach unless the task or current implementation requires
  otherwise.
- Prefer durable principles and checklists over line numbers, temporary class
  names, or one-off implementation details.
- Update or remove a BKM when the implementation that justified it changes.
- Keep Superpowers planning and design artifacts under `docs/superpowers/`
  temporary. Never commit them.

## Review the full change impact

Before editing, identify the user-visible contract and the narrowest owner of
the affected state. Then inspect every layer that can alter the result:

1. React state and event handling.
2. Browser persistence and recovery from stale data.
3. Base styles, theme overrides, and responsive media queries.
4. Keyboard behavior, focus indication, and accessible state.
5. Regression tests, build configuration, and deployment behavior.

Use `rg` to find every occurrence of a component, selector, storage key, or
copy string before changing shared UI structure. ReadFlux's styles include
theme and breakpoint overrides, so changing only the first matching selector
is not sufficient evidence that the result is consistent.

Keep changes scoped to the reported behavior. Avoid unrelated refactors unless
the existing structure prevents a safe implementation.

## Browser state and privacy

Use each browser storage mechanism for its established role:

- `localStorage` or `sessionStorage` stores the Miniflux connection depending
  on whether the user selected persistent login.
- `localStorage` stores durable UI preferences such as category and whole
  subscriptions-section collapse state.
- IndexedDB stores reading events, recommendation settings, connection-scoped
  entry caches, and resumable synchronization state.

Use a `readflux.` prefix for new storage keys. Initialize state defensively:
missing values use a stable default, structured values are parsed inside a
`try` block, and malformed values are removed or ignored rather than blocking
application startup.

Keep cached Miniflux data scoped to the active connection so switching servers
or users cannot mix entry state. Reset operations should remove only the data
the user asked to reset.

Never log, commit, upload, or add analytics around credentials, WebDAV
secrets, article contents, reading events, or derived recommendation data.

## Asynchronous data and Miniflux

Treat Miniflux collections as paginated unless the API contract proves the
result is bounded. Continue loading until the reported total is reached or an
empty page proves completion. This is especially important for unread and
starred entries, where silently loading only the first page changes product
behavior.

Preserve the current list snapshot when live entry state changes. Reading an
article may update its status without immediately removing it from the visible
list; rebuild filters only at the product-defined boundaries in `CLAUDE.md`.

For optimistic mutations:

1. Apply the local state change immediately.
2. Send the Miniflux request.
3. Roll back the local change if the request fails.
4. Give the user a concise success or failure message.

Run requests concurrently only when they are independent. Keep sequential
ordering when a later request depends on a previous page, cursor, persisted
offset, or mutation result.

When changing synchronization, verify both initial and incremental paths,
cached startup behavior, pagination termination, progress reporting, and
partial-failure behavior.

## UI and interaction

Use the installed Bootstrap Icons package for interface icons. Do not mix it
with Unicode approximations for equivalent controls; glyph rendering and
visual weight differ across platforms and fonts.

Model an interactive row as one visual unit. Hover, selected, active, text,
icon, and count colors should be driven by the element that represents the
complete row. Child controls may keep separate actions while inheriting the
row's visual state.

Keep interaction semantics explicit:

- Disclosure expands or collapses children.
- Selection changes the active category, feed, or view.
- Navigation changes location or the current mobile pane.

Do not make one implicit click target perform multiple unrelated actions.
Stateful controls should expose `aria-expanded` or `aria-current` where
appropriate, icon-only controls need an accessible label, and decorative icons
should be hidden from assistive technology.

For every sidebar or layout change, check:

- hover, selected, pressed, disabled, and focus-visible states;
- day and night themes;
- desktop, compact desktop, and mobile breakpoints;
- keyboard traversal and activation;
- long category and feed names;
- unread counts and empty states.

Persist UI state only when it is useful across sessions. Choose a stable
default, use a namespaced key, and verify that hiding a parent section does not
destroy independent child state.

## Testing strategy

Prefer behavioral tests for pure calculations, pagination, cache scoping, and
state transformations. They survive harmless refactors and provide the
clearest failure messages.

Source-structure tests are acceptable for important static contracts that the
current lightweight test stack cannot exercise in a browser, such as a
required icon package import or the absence of a removed control. Keep these
assertions focused on semantics rather than whitespace or unrelated JSX
formatting.

For a regression:

1. Add a focused assertion that would fail for the reported behavior.
2. Make the smallest implementation change that satisfies the product
   contract.
3. Where useful, assert both the intended behavior and the absence of the old
   failure mode.
4. Run the focused test, then the full suite.

Do not treat build success as a substitute for tests or lint. Each command
catches a different class of error.

## Definition of done

Before publishing a branch or updating a pull request:

```bash
npm test
npm run lint
npm run build
```

Then:

- inspect `git diff --check` and the final diff;
- confirm generated artifacts, credentials, `.env` files, local exports, and
  `docs/superpowers/` files are not committed;
- confirm the change preserves privacy and the static-only architecture;
- describe the root cause, user-visible impact, and verification results in the
  pull request;
- distinguish local verification from GitHub checks that have not run yet.
