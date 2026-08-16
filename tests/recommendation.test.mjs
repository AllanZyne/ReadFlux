import assert from "node:assert/strict";
import test from "node:test";

import {
  explainTermRule,
  extractRecommendationTerms,
  foldTermRules,
  sanitizeRecordedTerms,
} from "../src/recommendation-terms.ts";
import {
  createRankingExposure,
  deriveInterestProfile,
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

test("term extraction removes structural noise, stop words, years, URLs, and duplicates", () => {
  const terms = extractRecommendationTerms("The the LLVM and https://llvm.org/slides/2025.pdf C++ C# GPT-4 2025 LLVM");
  assert.deepEqual(terms, ["llvm", "c++", "c#", "gpt-4"]);
});

test("term extraction segments Chinese and keeps mixed technical tokens", () => {
  const terms = extractRecommendationTerms("这是一个关于人工智能和 LLVM 的技术文章 C++");
  assert.ok(terms.includes("人工"));
  assert.ok(terms.includes("智能"));
  assert.ok(terms.includes("llvm"));
  assert.ok(terms.includes("c++"));
  assert.ok(!terms.includes("的"));
});

test("user rules fold deterministically and Keep overrides a language default", () => {
  const rules = foldTermRules([
    { id: "a", clientId: "one", term: "IT", action: "ignore", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "b", clientId: "two", term: "it", action: "keep", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "c", clientId: "one", term: "llvm", action: "ignore", updatedAt: "2026-01-02T00:00:00Z" },
  ]);
  assert.deepEqual(extractRecommendationTerms("It is LLVM", rules), ["it"]);
  assert.equal(explainTermRule("it", rules).reason, "user");
});

test("remove operations restore defaults without mutating recorded terms", () => {
  const raw = ["the", "llvm", "llvm", "https", "2025"];
  const rules = foldTermRules([
    { id: "a", clientId: "one", term: "the", action: "keep", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "b", clientId: "two", term: "the", action: "remove", updatedAt: "2026-01-02T00:00:00Z" },
  ]);
  assert.deepEqual(sanitizeRecordedTerms(raw, rules), ["llvm"]);
  assert.deepEqual(raw, ["the", "llvm", "llvm", "https", "2025"]);
});

test("profile derivation deduplicates and normalizes each document contribution", () => {
  const now = Date.parse("2026-08-14T00:00:00.000Z");
  const repeated = deriveInterestProfile([event({ terms: ["llvm", "llvm", "rust"] })], [], now);
  const unique = deriveInterestProfile([event({ terms: ["llvm", "rust"] })], [], now);
  assert.equal(repeated.words.get("llvm"), unique.words.get("llvm"));
  assert.equal(repeated.words.get("rust"), unique.words.get("rust"));
});

test("score components explain the unclamped score and high affinity does not force 99", () => {
  const profile = {
    sources: new Map([[2, 10_000]]),
    words: new Map([["llvm", 10_000]]),
    negatives: new Map(),
  };
  const breakdown = scoreRecommendation({
    feedId: 2,
    text: "LLVM compiler internals",
    publishedAt: "2026-08-14T00:00:00.000Z",
    starred: false,
    now: Date.parse("2026-08-14T00:00:00.000Z"),
    profile,
  });
  assert.equal(
    breakdown.unclampedScore,
    Math.round((40 + breakdown.sourceScore + breakdown.termScore + breakdown.freshnessScore + breakdown.savedBonus - breakdown.negativePenalty) * 1000) / 1000,
  );
  assert.ok(breakdown.score < 99);
  assert.equal(RECOMMENDATION_ALGORITHM_VERSION, "heuristic-v2");
});

test("exposure capture bounds ordered items and attribution uses its documented one-based rank", () => {
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
    algorithmVersion: "heuristic-v2",
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
    algorithmVersion: "heuristic-v2",
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
