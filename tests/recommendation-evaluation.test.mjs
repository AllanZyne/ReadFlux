import assert from "node:assert/strict";
import test from "node:test";

import { RECOMMENDATION_ALGORITHM_VERSION } from "../src/recommendation.ts";
import {
  dedupeExposures,
  DUPLICATE_EXPOSURE_WINDOW_MS,
  evaluateRecommendations,
  pairwiseAuc,
} from "../src/recommendation-evaluation.ts";

const item = (entryId, rank, overrides = {}) => ({
  entryId,
  rank,
  score: 50,
  sourceScore: 10,
  termScore: 0,
  freshnessScore: 5,
  savedBonus: 0,
  negativePenalty: 0,
  statusPriority: 1,
  matchedTerms: [],
  ...overrides,
});

const exposure = (id, createdAt, items, overrides = {}) => ({
  id,
  createdAt,
  algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
  schemaVersion: 2,
  surface: "today",
  candidateCount: items.length,
  displayedCount: items.length,
  items,
  ...overrides,
});

const event = (overrides = {}) => ({
  id: "event-1",
  entryId: 1,
  feedId: 10,
  title: "Title",
  source: "Feed",
  terms: [],
  openedAt: "2026-08-14T01:00:00.000Z",
  activeSeconds: 60,
  scrollDepth: 1,
  readingTime: 1,
  origin: "recommendation",
  updatedAt: "2026-08-14T01:00:00.000Z",
  ...overrides,
});

const entry = (id, feedId, overrides = {}) => ({
  id,
  feedId,
  publishedAt: "2026-08-14T00:00:00.000Z",
  starred: false,
  recommendationText: "text",
  ...overrides,
});

test("pairwise AUC compares positives and negatives only within the same group", () => {
  const result = pairwiseAuc([
    { group: "a", label: true, score: 3 },
    { group: "a", label: false, score: 1 },
    { group: "a", label: false, score: 3 },
    { group: "b", label: false, score: 100 },
  ]);
  assert.equal(result.pairs, 2);
  assert.equal(result.auc, 0.75);
  assert.equal(result.tieShare, 0.5);
  assert.equal(pairwiseAuc([{ group: "a", label: true, score: 1 }]).auc, null);
});

test("duplicate exposures from one client within the window merge into the first", () => {
  const items = [item(1, 1), item(2, 2)];
  const start = Date.parse("2026-08-14T00:00:00.000Z");
  const at = (offset) => new Date(start + offset).toISOString();
  const { exposures, aliases } = dedupeExposures([
    exposure("a", at(0), items, { seenEntryIds: [1] }),
    exposure("b", at(60_000), items, { seenEntryIds: [2] }),
    exposure("c", at(60_000), items, { remoteClientId: "other" }),
    exposure("d", at(60_000 + DUPLICATE_EXPOSURE_WINDOW_MS + 1), items),
    exposure("e", at(60_000 + DUPLICATE_EXPOSURE_WINDOW_MS + 2), [item(2, 1), item(1, 2)]),
  ]);
  assert.deepEqual(exposures.map((value) => value.id), ["a", "c", "d", "e"]);
  assert.deepEqual([...aliases], [["b", "a"]]);
  assert.deepEqual(exposures[0].seenEntryIds, [1, 2]);
});

test("evaluation replays only earlier data and restricts negatives to seen items", () => {
  const items = [item(1, 1, { feedId: 10 }), item(2, 2, { feedId: 20 }), item(3, 3, { feedId: 20 })];
  const base = {
    timeZone: "UTC",
    entries: [entry(1, 10), entry(2, 20), entry(3, 20)],
    exposures: [exposure("ranking-1", "2026-08-14T00:30:00.000Z", items, { seenEntryIds: [1, 2] })],
    events: [event({ rankingId: "ranking-1", exposedRank: 1 })],
  };
  const result = evaluateRecommendations(base);
  assert.equal(result.exposures.withAttributedOpens, 1);
  assert.equal(result.exposures.seenTracked, 1);
  assert.equal(result.coverage.items, 2);
  assert.equal(result.metrics.opened.positives, 1);
  assert.equal(result.metrics.opened.recorded.pairs, 1);

  const later = evaluateRecommendations({
    ...base,
    events: [...base.events, event({ id: "later", entryId: 9, feedId: 20, openedAt: "2026-08-15T00:00:00.000Z", activeSeconds: 900 })],
  });
  assert.deepEqual(later.metrics, result.metrics);
});

test("evaluation counts opens attributed to a de-duplicated exposure", () => {
  const items = [item(1, 1, { feedId: 10 }), item(2, 2, { feedId: 20 })];
  const result = evaluateRecommendations({
    timeZone: "UTC",
    entries: [entry(1, 10), entry(2, 20)],
    exposures: [
      exposure("first", "2026-08-14T00:30:00.000Z", items),
      exposure("duplicate", "2026-08-14T00:31:00.000Z", items),
    ],
    events: [event({ rankingId: "duplicate", exposedRank: 1 })],
  });
  assert.equal(result.exposures.afterDeduplication, 1);
  assert.equal(result.exposures.withAttributedOpens, 1);
  assert.equal(result.metrics.opened.positives, 1);
});
