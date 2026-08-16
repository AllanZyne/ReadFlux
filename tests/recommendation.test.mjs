import assert from "node:assert/strict";
import test from "node:test";

import {
  createRankingExposure,
  deriveInterestProfile,
  extractLegacyRecommendationTerms,
  rankingAttribution,
  recommendationDiagnostics,
  recordBulkDismissal,
  RECOMMENDATION_ALGORITHM_VERSION,
  scoreRecommendation,
} from "../src/recommendation.ts";

const event = (overrides = {}) => ({
  id: "event-1",
  entryId: 1,
  feedId: 2,
  title: "LLVM",
  source: "Compiler feed",
  terms: ["llvm"],
  openedAt: "2026-08-14T00:00:00.000Z",
  activeSeconds: 60,
  scrollDepth: 1,
  origin: "recommendation",
  updatedAt: "2026-08-14T00:00:00.000Z",
  ...overrides,
});

test("observable v1 preserves legacy token extraction behavior", () => {
  assert.deepEqual(
    extractLegacyRecommendationTerms("The the LLVM https org C++ C# GPT-4 2025 LLVM"),
    ["the", "the", "llvm", "https", "org", "c++", "gpt-4", "2025", "llvm"],
  );
});

test("observable v1 preserves repeated event term contributions", () => {
  const profile = deriveInterestProfile([
    event({ terms: ["llvm", "llvm"] }),
  ], [], Date.parse("2026-08-14T00:00:00.000Z"));
  assert.equal(profile.words.get("llvm"), 8);
});

test("score breakdown preserves the production v1 formula", () => {
  const breakdown = scoreRecommendation({
    feedId: 2,
    text: "LLVM compiler internals",
    publishedAt: "2026-08-14T00:00:00.000Z",
    starred: false,
    now: Date.parse("2026-08-14T00:00:00.000Z"),
    profile: {
      sources: new Map([[2, 10]]),
      words: new Map([["llvm", 30]]),
      negatives: new Map(),
    },
  });
  assert.deepEqual({
    sourceScore: breakdown.sourceScore,
    termScore: breakdown.termScore,
    freshnessScore: breakdown.freshnessScore,
    unclampedScore: breakdown.unclampedScore,
    score: breakdown.score,
  }, {
    sourceScore: 25,
    termScore: 20,
    freshnessScore: 12,
    unclampedScore: 101,
    score: 99,
  });
  assert.equal(RECOMMENDATION_ALGORITHM_VERSION, "heuristic-v1-observable");
});

test("exposure capture bounds ordered items and attribution uses a one-based rank", () => {
  const breakdown = {
    score: 80,
    unclampedScore: 80,
    sourceScore: 10,
    termScore: 10,
    freshnessScore: 10,
    savedBonus: 0,
    negativePenalty: 0,
    matchedTerms: ["llvm", "compiler", "extra", "discarded"],
  };
  const exposure = createRankingExposure({
    id: "ranking-1",
    createdAt: "2026-08-15T00:00:00.000Z",
    candidateCount: 50,
    candidates: Array.from({ length: 55 }, (_, index) => ({ entryId: index + 100, breakdown, statusPriority: 1 })),
  });
  assert.equal(exposure.schemaVersion, 2);
  assert.equal(exposure.displayedCount, 50);
  assert.equal(exposure.items[0].rank, 1);
  assert.equal(exposure.items[49].rank, 50);
  assert.deepEqual(exposure.items[0].matchedTerms, ["llvm", "compiler", "extra"]);
  assert.deepEqual(rankingAttribution(exposure, 100), {
    rankingId: "ranking-1",
    exposedRank: 1,
    algorithmVersion: "heuristic-v1-observable",
  });
  assert.deepEqual(rankingAttribution(exposure, 999), {});
});

test("bulk dismissal records only exposed Top 50 items without changing scores", () => {
  const breakdown = {
    score: 80,
    unclampedScore: 80,
    sourceScore: 10,
    termScore: 10,
    freshnessScore: 10,
    savedBonus: 0,
    negativePenalty: 0,
    matchedTerms: [],
  };
  const exposure = createRankingExposure({
    id: "ranking-1",
    createdAt: "2026-08-15T00:00:00.000Z",
    candidateCount: 60,
    candidates: Array.from({ length: 60 }, (_, index) => ({ entryId: index + 1, breakdown, statusPriority: 1 })),
  });
  const updated = recordBulkDismissal(exposure, [2, 50, 51, 999], "2026-08-15T01:00:00.000Z");
  assert.deepEqual(updated.bulkDismissedEntryIds, [2, 50]);
  assert.equal(updated.bulkDismissedAt, "2026-08-15T01:00:00.000Z");
  assert.deepEqual(updated.items, exposure.items);
});

test("diagnostics use matching exposure items rather than opens as their denominator", () => {
  const exposure = {
    id: "ranking-1",
    createdAt: "2026-08-14T00:00:00.000Z",
    algorithmVersion: "heuristic-v1-observable",
    schemaVersion: 1,
    surface: "today",
    candidateCount: 3,
    displayedCount: 3,
    items: [1, 2, 3].map((entryId, index) => ({
      entryId,
      rank: index + 1,
      score: index < 2 ? 80 : 99,
      sourceScore: 1,
      termScore: 1,
      freshnessScore: 1,
      savedBonus: 0,
      negativePenalty: 0,
      statusPriority: 1,
      matchedTerms: [],
    })),
    bulkDismissedAt: "2026-08-14T01:00:00.000Z",
    bulkDismissedEntryIds: [3],
  };
  const diagnostics = recommendationDiagnostics([exposure], [
    event({ rankingId: "ranking-1", exposedRank: 1, starred: true, starredAt: "2026-08-14T00:30:00.000Z" }),
    event({ id: "duplicate", rankingId: "ranking-1", exposedRank: 1 }),
    event({ id: "remote", rankingId: "unknown-ranking", exposedRank: 1 }),
  ]);
  assert.equal(diagnostics.displayedCount, 3);
  assert.equal(diagnostics.attributedOpenCount, 2);
  assert.equal(diagnostics.rankEngagement[0].engagedOpens, 1);
  assert.equal(Math.round(diagnostics.clampedPercent), 33);
  assert.equal(Math.round(diagnostics.tiePercent), 67);
  assert.equal(diagnostics.evaluationAtK[0].impressions, 3);
  assert.equal(diagnostics.evaluationAtK[0].opens, 1);
  assert.equal(diagnostics.evaluationAtK[0].starred, 1);
  assert.equal(diagnostics.evaluationAtK[0].bulkDismissed, 1);
});
