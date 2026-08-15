import assert from "node:assert/strict";
import test from "node:test";

import {
  createRankingExposure,
  deriveInterestProfile,
  extractLegacyRecommendationTerms,
  rankingAttribution,
  recommendationDiagnostics,
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
    candidates: Array.from({ length: 45 }, (_, index) => ({ entryId: index + 100, breakdown, statusPriority: 1 })),
  });
  assert.equal(exposure.displayedCount, 40);
  assert.equal(exposure.items[0].rank, 1);
  assert.equal(exposure.items[39].rank, 40);
  assert.deepEqual(exposure.items[0].matchedTerms, ["llvm", "compiler", "extra"]);
  assert.deepEqual(rankingAttribution(exposure, 100), {
    rankingId: "ranking-1",
    exposedRank: 1,
    algorithmVersion: "heuristic-v1-observable",
  });
  assert.deepEqual(rankingAttribution(exposure, 999), {});
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
  };
  const diagnostics = recommendationDiagnostics([exposure], [
    event({ rankingId: "ranking-1", exposedRank: 1 }),
    event({ id: "duplicate", rankingId: "ranking-1", exposedRank: 1 }),
    event({ id: "remote", rankingId: "unknown-ranking", exposedRank: 1 }),
  ]);
  assert.equal(diagnostics.displayedCount, 3);
  assert.equal(diagnostics.attributedOpenCount, 2);
  assert.equal(diagnostics.rankEngagement[0].engagedOpens, 1);
  assert.equal(Math.round(diagnostics.clampedPercent), 33);
  assert.equal(Math.round(diagnostics.tiePercent), 67);
});
