# ReadFlux Development BKMs

`CLAUDE.md` defines mandatory constraints. This file keeps short, repository-backed implementation checklists.

## Principles

- Record only practices proven by current code or a resolved regression.
- Remove guidance when its supporting implementation changes.
- Keep changes scoped; avoid unrelated refactors.
- Treat `docs/superpowers/` as temporary working space and never commit it.

## Before changing code

- Identify the user-visible contract and the narrowest owner of affected state.
- Use `rg` to find related components, selectors, storage keys, copy, and tests before editing.
- Check state, persistence, base CSS, themes, media queries, accessibility, tests, and deployment.
- After changing DOM structure, recheck selectors and tests that depend on element type, child order, or `:nth-child`.

## Browser state and Miniflux data

- Keep connections in `localStorage` or `sessionStorage`, UI preferences in `localStorage`, and caches and profiles in IndexedDB.
- Prefix storage keys with `readflux.`. Catch storage failures, use safe defaults, and ignore or remove malformed values.
- Keep caches connection-scoped; never expose credentials, articles, reading events, or recommendation data.
- Paginate complete collections, especially unread and starred entries.
- Preserve list snapshots when live read state changes.
- Roll back failed optimistic mutations and show concise feedback.
- Run requests concurrently only when they are independent.

## UI and interaction

- Use Bootstrap Icons instead of Unicode approximations for interface icons.
- Apply hover and selected styles to the complete row: icon, label, and count.
- Keep disclosure, selection, and navigation as separate actions.
- Use suitable `aria-expanded`, `aria-current`, accessible labels, and focus-visible styles.
- Check both themes, desktop and mobile, keyboard behavior, long names, counts, and empty states.
- Persist UI state only when useful; hiding a parent must not destroy child state.

## Tests and review feedback

- For regressions, add a focused failing assertion, make the smallest fix, then run focused and full tests.
- Test behavior or compatibility boundaries; do not pin irrelevant versions, whitespace, or formatting.
- Use source tests only for important static contracts the current stack cannot test behaviorally.
- Read thread state, group unresolved actionable comments, and validate each against current code.
- Trace each fix to its thread and root cause; do not bundle unrelated cleanup.
- After pushing, re-fetch threads: outdated is not resolved, and replies belong in the original thread.

## Definition of done

```bash
git diff --check
npm test
npm run lint
npm run build
```

- Review the diff for unrelated changes, secrets, generated files, `.env`, exports, and `docs/superpowers/`.
- In the PR, state the root cause, user-visible impact, and verification.
- Distinguish local verification from GitHub checks that have not run.
