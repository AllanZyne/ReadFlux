# Contributing to ReadFlux

Thank you for helping improve ReadFlux. Small, focused pull requests are
welcome.

Before opening a pull request, run:

```bash
npm install
npm run lint
npm test
npm run build
```

## Improving a translation

Interface translations are plain JSON files:

- `src/locales/en.json` — English and the fallback/reference catalog
- `src/locales/zh-CN.json` — Simplified Chinese
- `src/locales/fr.json` — French

To fix wording, punctuation, or terminology, edit the value in the relevant
file without changing its key. This can be done directly with GitHub's file
editor; no React knowledge is required.

Keep interpolation placeholders such as `{{count}}`, `{{title}}`, and
`{{status}}` unchanged. Keys ending in `_one` and `_other` are plural forms and
must stay together. `npm test` verifies that every locale has the same keys.

## Adding a language

1. Copy `src/locales/en.json` to `src/locales/<locale>.json` and translate every
   value.
2. Add the locale code to `SUPPORTED_LANGUAGES` in `src/languages.ts`, then
   import its catalog and add it to `resources` in `src/i18n.ts`.
3. Add the language's native display name under `language` in every locale
   catalog so the Settings selector can display it.
4. Add the new locale to the catalog list in `tests/i18n.test.mjs`.
5. Run the checks shown above.

Use a standard BCP 47 locale code such as `de`, `pt-BR`, or `zh-TW`. English is
the fallback when a translation is unavailable.

## Adding interface text

Do not place user-facing copy directly in React components. Add an English key
to `src/locales/en.json`, add the same key to every other catalog, then render
it with `t("section.key")`. Use i18next interpolation and plural forms for
dynamic values instead of assembling translated sentences from fragments.
