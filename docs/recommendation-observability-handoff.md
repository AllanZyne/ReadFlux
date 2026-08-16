# Recommendation observability and evaluation handoff

## Purpose

Improve ReadFlux recommendation observability so collected reading data can:

1. explain why an article received its rank;
2. reveal ranking and feature-engineering failures;
3. measure recommendation quality rather than only inspect the learned profile;
4. support offline comparisons and later controlled ranking experiments.

This should be implemented in a separate PR from WebDAV recommendation-event
sync. The current WebDAV PR is draft PR #63 on branch
`agent/sync-recommendation-events-with-webdav` at commit `70d3704`. It provides
cross-client event transport but deliberately does not change recommendation
scoring or add exposure logging.

## Current production evidence

The current Safari profile was inspected on 2026-08-14. The Recommendation Data
panel showed:

- 171 reading events;
- 98 valid interest events (57.3%);
- 30 seconds average foreground time;
- 39% average scroll depth;
- 70 Miniflux saved articles;
- 0 explicit Helpful responses;
- 0 explicit Not interested responses.

The 73 events below the current validity threshold represent 42.7% of the raw
event set. Raw-event samples include many 0–10 second, 0%-scroll opens as well
as longer 35–150 second, 100%-scroll reads.

The highest-weighted terms included:

```text
the        372.7
llvm       365.1
and        246.9
https      212.5
---        203.3
org        200.7
devmtg     194.7
slides     188.7
this       159.6
for        157.1
eurollvm   143.5
developers 113.7
meeting    110.7
mlir       108.0
2025       105.0
talk       105.0
with       101.6
that        90.1
pdf         87.0
```

This is direct evidence that the profile is dominated by English stop words,
URL/document boilerplate, years, and repeated conference vocabulary.

The top displayed source weights ranged from approximately 13 to 167. The
current source-score cap is reached at a source weight of 8.33, so every one of
those displayed sources already contributes the same maximum source score.

## Confirmed problems in the current algorithm

### 1. Token extraction produces low-information terms

`termsOf` in `src/App.tsx` lowercases text, splits on punctuation, filters only
by length, and takes the first 80 tokens. It does not:

- remove stop words;
- remove URLs, years, and document boilerplate;
- deduplicate tokens within an article;
- normalize common URL or conference fragments;
- segment Chinese text into useful terms.

Repeated occurrences are counted repeatedly both while learning interest
weights and while scoring candidates. This amplifies common terms further.

### 2. Recommendation scores saturate

The current formula is effectively:

```text
44
+ min(25, sourceAffinity * 3)
+ min(20, sum(matchedTermWeights))
+ freshness in [0, 12]
+ 8 if saved
- negativePenalty * 2
```

The final result is clamped to 1–99.

Consequences:

- source contribution reaches its maximum at only 8.33 affinity;
- any one of the observed high-weight terms already fills the entire 20-point
  term contribution;
- a recent article from a learned source containing one common learned term is
  approximately `44 + 25 + 20 + 10 = 99`;
- many candidates likely tie at 99, causing the recommendation layer to lose
  discrimination;
- `compareSmartFeedEntries` first prioritizes updated/unread status and then
  compares only the saturated score, so ties fall back to existing array order.

### 3. Collected data is click/open biased

`ReadingEvent` currently records only opened articles:

- entry and feed IDs;
- title, source, and extracted terms;
- open/update time;
- foreground seconds and maximum scroll depth;
- entry origin;
- optional explicit feedback;
- estimated reading time;
- selected list position.

`listPosition` describes the rank of an opened item, but there is no record of
items shown and skipped. The dataset therefore cannot produce a denominator
for click or engaged-read rates.

### 4. Ranking context is missing

There is no persisted record of:

- the candidate set or displayed Top K;
- the score assigned at exposure time;
- individual score components;
- algorithm/model version;
- a ranking or impression identifier;
- score ties and saturation;
- the profile state used to calculate the ranking;
- experiment assignment.

As a result, the current logs cannot exactly replay or explain historical
rankings and cannot reliably compare a new ranker with the old one.

## What current events can and cannot evaluate

Current events can support:

- source and term-weight inspection;
- valid-event ratios and engagement distributions;
- engagement comparisons between opened recommendation/feed/search/saved
  articles;
- rank-versus-engagement analysis among opened articles only;
- profile concentration and drift checks;
- feature pollution and score-saturation diagnosis.

Current events cannot support:

- impression, open, or engaged-open rate at K;
- skip rates by rank;
- Precision@K, Recall@K, or NDCG;
- calibration by score bucket;
- unbiased comparison with an alternative ranker;
- exact historical ranking replay or explanation.

WebDAV synchronization increases sample completeness across ReadFlux clients,
but does not fix these observability limitations.

## Term hygiene, language handling, and user control

Keyword quality is language-dependent, so a single hard-coded English stop-word
list is not sufficient. At the same time, users should not have to manually
remove obvious extraction failures such as URLs and punctuation. Use three
layers, in this order:

1. mandatory structural cleanup for universally useless tokens;
2. conservative, versioned default ignore lists for supported languages;
3. user-managed Ignore and Keep lists.

The Keep list is necessary because some common stop words are meaningful in
technical feeds. For example, `go`, `rust`, `us`, and `it` can be programming
languages, projects, regions, or acronyms. A user Keep rule must override a
default ignore rule. A user Ignore rule must override normal extraction. User
rules should use normalized exact-token matching in the first version; do not
add regular expressions or substring matching yet.

### Default extraction and ignore rules

Create a pure recommendation-term module rather than leaving tokenization in
`App.tsx`. Its extraction pipeline should:

- normalize Unicode with NFKC and lowercase where appropriate;
- remove URLs, email addresses, and HTML remnants before tokenization;
- reject pure punctuation/dashes and require at least one letter or number;
- retain meaningful technical tokens such as `c++`, `c#`, `gpt-4`, and `llvm`;
- remove obvious URL/document boilerplate such as `http`, `https`, `www`,
  `com`, `org`, and `html`;
- remove or downweight standalone years and numeric boilerplate;
- deduplicate normalized terms within each document/event;
- use `Intl.Segmenter` for languages without whitespace boundaries, with a
  deterministic fallback where it is unavailable.

Maintain default ignore lists by language and assign them an explicit version.
Language selection should be lightweight and conservative: use dominant script
and stop-word evidence from the title/summary where available. If language is
uncertain, apply only the universal structural-noise list. It is better to leave
an ambiguous term available for learning than to silently remove a meaningful
technical term.

Default lists are application data, not user profile data. They should ship
with the client, remain reviewable in source control, and have focused tests for
English, Chinese, mixed-language titles, and technical-token exceptions.

### User interface

Add a one-click Ignore action next to terms in Recommendation Data. Add a
settings editor for:

- user-ignored terms;
- terms explicitly kept despite the default list;
- searching whether a term is ignored and why;
- removing a user rule.

The UI does not need to render the entire default list. It can show the list
version, supported languages, and item counts, then explain an individual term
when searched. Ignoring a term means that it contributes neither positive nor
negative recommendation weight; it must not be converted into negative
feedback. Rule changes should recompute the local derived recommendation model
immediately and affect the next Today refresh, while leaving raw reading events
immutable.

### Historical event behavior

Do not rewrite stored `ReadingEvent` records. During profile derivation, pass
their recorded `terms` through the current versioned sanitizer and user rules.
This immediately removes known bad historical tokens without destroying the
audit trail. Full historical re-tokenization remains impossible because events
do not retain full summaries/article text, although stored titles can be
re-tokenized if a future migration explicitly chooses to do so.

Normalize each event's contribution across its unique accepted terms (for
example, divide event weight by `sqrt(uniqueTermCount)`) so a long or noisy
document cannot give full event weight to every term. Candidate terms should
also be unique. Use a log-scaled profile contribution initially; add
document-frequency/IDF weighting after exposure logging provides enough data
to calibrate it.

### Synchronizing user term rules through WebDAV

Ignore/Keep rules should be consistent across ReadFlux clients. They are user
configuration, not a generated recommendation profile, and should follow the
same conflict-free ownership rule as reading-event synchronization: each
client writes only inside its own WebDAV directory and reads every ReadFlux
client directory.

Store append-only term-rule operations in a client-owned file, for example:

```text
<client-id>/preferences/term-rules.jsonl
```

An operation should contain at least:

```ts
type TermRuleOperation = {
  id: string;                 // UUID, used for deduplication
  clientId: string;
  term: string;               // normalized exact token
  action: "ignore" | "keep" | "remove";
  updatedAt: string;          // UTC ISO timestamp
};
```

Fold all clients' operations into one effective rule per normalized term using
last-write-wins by `(updatedAt, id)` so equal timestamps resolve
deterministically. `remove` deletes the user's override and returns the term to
default behavior; it does not remove historical operations from remote files.
The client should compact only its own operation file when needed and must not
edit another client's directory.

Term-rule upload and download should run with the existing user-configurable
WebDAV synchronization and the Sync now action. A sync failure must leave local
rules usable and must be reported like other ordinary WebDAV disconnections.
No encryption is required beyond the configured WebDAV transport.

## Proposed data model

### RankingExposure

Create a new local record whenever the Today list first captures a new order,
then synchronize it through the configured WebDAV connection.
Do not create records on every React render.

```ts
type RankingExposure = {
  id: string;                  // rankingId, UUID
  createdAt: string;           // UTC ISO timestamp
  algorithmVersion: string;    // explicit stable version, e.g. "heuristic-v2"
  surface: "today";
  candidateCount: number;
  displayedCount: number;
  items: RankingExposureItem[]; // recommended Top 50
  bulkDismissedAt?: string;
  bulkDismissedEntryIds?: number[];
};

type RankingExposureItem = {
  entryId: number;
  rank: number;                // zero- or one-based; choose and document one
  score: number;
  sourceScore: number;
  termScore: number;
  freshnessScore: number;
  savedBonus: number;
  negativePenalty: number;
  statusPriority: number;
  matchedTerms: string[];      // keep short, e.g. top 3
};
```

Top 50 is sufficient for initial diagnostics and bounds storage growth.
Persist the ranking when `visibleIds` is first captured for a fresh Today list.

### ReadingEvent additions

Extend locally created events with optional ranking attribution:

```ts
type ReadingEvent = {
  // existing fields...
  rankingId?: string;
  exposedRank?: number;
  algorithmVersion?: string;
  starred?: boolean;           // latest star state changed during this read
  starredAt?: string;          // timestamp of that state change
};
```

When a Today article is opened, look up its latest captured exposure and attach
these fields. Feed, search, saved, and direct-route opens may omit them. Record
star and unstar actions independently of article length. When the user marks the
remaining Today list read in bulk, annotate only the affected items that belong
to the captured Top 50. Treat this as a weak skip outcome for evaluation, not as
per-item explicit negative feedback and not as an input to the interest profile.

### Versioning and WebDAV

- Keep ranking schema versions explicit.
- Synchronize exposures because cross-client evaluation requires both the
  reading-event numerator and its matching exposure denominator.
- Use client-owned monthly files under
  `<client-id>/exposures/YYYY-MM.json`, never a shared manifest.
- Other clients download exposures into a separate read-only mirror. A client
  must upload only records created locally under its own client ID.
- Keep exposure files separate from reading-event files so each stream can be
  validated, retried, and evolved independently.

## Recommended implementation sequence

### Phase 1: make scoring inspectable without changing behavior

1. Extract tokenization, interest derivation, and candidate scoring out of
   `App.tsx` into pure modules.
2. Return a structured score breakdown rather than only a number and reason.
3. Add an explicit `algorithmVersion` constant.
4. Persist local and read-only remote `RankingExposure` records in separate
   IndexedDB stores.
5. Attribute Today reading events to `rankingId` and `exposedRank`.
6. Add Recommendation Data diagnostics:
   - score distribution;
   - percentage clamped at 99;
   - tie rate;
   - source/term/freshness contribution distributions;
   - engaged-open rate by rank once enough exposures exist.

Keeping Phase 1 behavior-compatible separates logging correctness from ranking
changes.

### Phase 2: fix the already-confirmed ranking defects

1. Extract a pure, versioned recommendation-term pipeline.
2. Apply universal cleanup plus conservative language-specific default lists.
3. Deduplicate terms within each document/event and normalize per-document
   contribution.
4. Apply Ignore/Keep rules while deriving profiles and scoring candidates,
   including recorded historical terms without mutating raw events.
5. Add the rule-management UI and one-click Ignore action.
6. Synchronize append-only term-rule operations through client-owned WebDAV
   directories.
7. Prefer document-frequency-aware or normalized term weights over raw sums.
8. Replace hard early saturation with normalized/log-scaled contributions.
9. Add deterministic tie-breaking.
10. Version the changed algorithm separately from the current heuristic.

### Phase 3: evaluation and controlled comparison

Add aggregate local reports over local and WebDAV-mirrored records for:

- open rate, engaged-open rate, star rate, and bulk-dismiss rate at 5/10/20/50;
- engaged-open rate by rank;
- score calibration by bucket;
- saturation and tie rate;
- source concentration/diversity;
- recommendation-origin versus non-recommendation-origin engagement;
- explicit feedback coverage.

Do not infer reading intent from estimated article length. A short or long
article may be starred, read deeply, skimmed, or skipped depending on the user.
Keep those outcomes separate so later evaluation can choose or combine them
without baking one person's reading workflow into the data model.

Logged exposure from only one ranker is still position biased. To compare
rankers causally, introduce a small controlled experiment only after exposure
logging is stable. A reasonable single-user design is to randomly swap or
interleave close-score candidates for 5–10% of eligible rankings, record the
assignment, and keep the experiment easy to disable.

## Suggested acceptance criteria

### Logging

- One exposure is written when a new Today order is captured, not per render.
- Every exposure has an algorithm version and deterministic ordered items.
- Opening a displayed Today item references the correct exposure and rank.
- Refreshing/re-entering Today creates a new exposure only when a fresh order is
  intentionally generated.
- Exposure persistence failures do not block reading or Miniflux sync.

### Diagnostics

- The Recommendation Data tab shows score saturation and tie rate.
- It can distinguish exposures, opens, valid/engaged opens, and explicit
  feedback.
- Metrics never treat opened events as the exposure denominator.
- Remote WebDAV reading events and ranking exposures remain read-only.
- Every attributed remote event is evaluated only when its matching remote
  exposure is present; missing denominators are never synthesized.

### Feature/scoring fixes

- repeated terms in one document contribute only once unless intentionally
  designed otherwise;
- `the`, `and`, `https`, `org`, standalone years, and equivalent boilerplate do
  not become leading interest terms;
- tests cover English, Chinese, URLs, repeated terms, and mixed-language titles;
- technical terms such as `c++`, `c#`, `gpt-4`, and user-kept ambiguous terms
  survive filtering;
- a user Ignore rule removes a term from both historical-profile derivation and
  new candidate scoring without rewriting raw events;
- a user Keep rule overrides a default language ignore rule;
- synchronized rule folding is deterministic and clients write only their own
  WebDAV directories;
- score-breakdown components sum to the final unclamped score;
- tests include high-affinity profiles and verify the ranker does not collapse
  most candidates to the maximum score;
- Today sorting remains deterministic.

## Relevant code

- `src/App.tsx`
  - `termsOf`: current token extraction
  - `interest` memo: event-to-profile derivation
  - `stories` memo: score and reason calculation
  - `visibleIds` capture: natural place to create a ranking exposure
  - `choose`: creates `ReadingEvent` and records selected position
- `src/readflux-client.ts`
  - `ReadingEvent` schema
  - IndexedDB version and stores
  - local event persistence
- `src/smart-feeds.mjs`
  - Today status priority and score comparison
- `tests/smart-feeds.test.mjs`
  - current ranking-order tests
- `tests/reading-events.test.mjs`
  - current event validation tests
- `src/webdav-sync.ts`
  - current client-owned monthly reading-event transport from PR #63

## Validation commands

Run before handoff or PR publication:

```bash
npm run lint
npm test
npm run build
git diff --check
```

Add focused behavioral tests for the extracted tokenizer, scorer, exposure
capture, event attribution, and derived metrics. Avoid relying only on static
source-regex tests for the new evaluation logic.

## Scope boundaries

- Exposure sync is explicitly approved for cross-client evaluation; do not
  change WebDAV credentials or the client-owned-directory convention.
- Term-rule synchronization is approved scope, but should reuse the existing
  WebDAV connection, scheduling, and client-owned-directory conventions rather
  than changing credential handling or introducing a shared writable file.
- Do not add analytics or transmit logs to a third-party service.
- Keep recommendation computation deterministic and local by default.
- Do not expose raw numeric recommendation scores in the article list; scores
  and breakdowns belong in Recommendation Data diagnostics.
- Do not let diagnostics reorder the currently captured Today list.
