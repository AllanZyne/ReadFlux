import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createRankingExposure,
  deriveInterestProfile,
  extractRecommendationTerms,
  foldTopicFeedback,
  rankingAttribution,
  recommendationDiagnostics,
  recordBulkDismissal,
  RECOMMENDATION_ALGORITHM_VERSION,
  scoreRecommendation,
  selectedTopicTermsByEntry,
} from "../src/recommendation.ts";
import { extractRecommendationCandidateTerms } from "../src/recommendation-terms.ts";

const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const termSource = await readFile(new URL("../src/recommendation-terms.ts", import.meta.url), "utf8");
const termWorkerSource = await readFile(new URL("../src/recommendation-terms.worker.ts", import.meta.url), "utf8");

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

test("candidate extraction removes obvious noise and preserves technical terms", () => {
  assert.deepEqual(
    extractRecommendationTerms("The the LLVM https://llvm.org/slides/2025.pdf C++ C# GPT-4 2025 LLVM"),
    ["llvm", "c++", "c#", "gpt-4"],
  );
});

test("candidate extraction removes numbers, dates, times, months, and weekdays", () => {
  assert.deepEqual(
    extractRecommendationTerms("LLVM 42 3.14 80% 2026-08-16 08:30 August Sunday GPT-4 IPv6 C++20"),
    ["llvm", "gpt-4", "ipv6", "c++20"],
  );
});

test("Chinese candidates exclude single characters and keep mixed technical tokens", () => {
  const terms = extractRecommendationCandidateTerms(
    "人工智能和LLVM编译器优化技术",
    "这是一个关于中文关键词提取的技术文章",
  );
  assert.ok(terms.includes("llvm"));
  assert.ok(terms.every((term) => !/^\p{Script=Han}$/u.test(term)));
});

test("candidate extraction gives title terms more weight than summary terms", () => {
  assert.equal(extractRecommendationCandidateTerms("LLVM", "compiler internals")[0], "llvm");
});

test("article opening delegates Jieba extraction and dictionary warmup to a worker", () => {
  assert.match(appSource, /terms:\s*\[\][\s\S]*?extractRecommendationCandidateTermsAsync/);
  assert.match(appSource, /const initialPersistence = putReadingEvent\(readingEvent\)[\s\S]*?await initialPersistence/);
  assert.match(termSource, /new Worker\(new URL\("\.\/recommendation-terms\.worker\.ts"/);
  assert.match(termWorkerSource, /tag\("中文分词预热", true\)/);
});

test("reading and saving never imply topic interest", () => {
  const profile = deriveInterestProfile([event({ terms: ["llvm"] })], [
    { feedId: 2, text: "LLVM" },
  ], Date.parse("2026-08-14T00:00:00.000Z"));
  assert.equal(profile.words.size, 0);
  assert.ok((profile.sources.get(2) ?? 0) > 0);
});

test("only the latest explicit per-article topic choice contributes", () => {
  const selected = event({
    topicFeedback: [
      { id: "a", term: "LLVM", interested: true, updatedAt: "2026-08-14T00:00:00.000Z" },
      { id: "b", term: "llvm", interested: false, updatedAt: "2026-08-14T01:00:00.000Z" },
      { id: "c", term: "llvm", interested: true, updatedAt: "2026-08-14T02:00:00.000Z" },
    ],
  });
  assert.deepEqual(foldTopicFeedback([selected]).map(({ term, interested }) => ({ term, interested })), [
    { term: "llvm", interested: true },
  ]);
  const profile = deriveInterestProfile([selected], [], Date.parse("2026-08-14T02:00:00.000Z"));
  assert.equal(profile.words.get("llvm"), 1);
  assert.equal(profile.negatives.size, 0);
});

test("selected topics are folded once into an entry lookup", () => {
  const selected = selectedTopicTermsByEntry([
    event({ entryId: 1, topicFeedback: [{ id: "a", term: "LLVM", interested: true, updatedAt: "2026-08-14T00:00:00.000Z" }] }),
    event({ id: "event-2", entryId: 2, topicFeedback: [{ id: "b", term: "Rust", interested: true, updatedAt: "2026-08-14T00:00:00.000Z" }] }),
  ]);
  assert.deepEqual([...selected.get(1) ?? []], ["llvm"]);
  assert.deepEqual([...selected.get(2) ?? []], ["rust"]);
});

test("log-scaled scoring retains discrimination at high affinity", () => {
  const breakdown = scoreRecommendation({
    feedId: 2,
    text: "LLVM compiler internals",
    publishedAt: "2026-08-14T00:00:00.000Z",
    starred: false,
    now: Date.parse("2026-08-14T00:00:00.000Z"),
    profile: {
      sources: new Map([[2, 10_000]]),
      words: new Map([["llvm", 10_000]]),
      negatives: new Map(),
    },
  });
  assert.equal(breakdown.sourceScore, 20);
  assert.ok(breakdown.termScore > 20 && breakdown.termScore < 24);
  assert.ok(breakdown.unclampedScore < 99);
  assert.equal(breakdown.score, Math.round(breakdown.unclampedScore));
  assert.equal(RECOMMENDATION_ALGORITHM_VERSION, "heuristic-v2-explicit-topics");
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
    algorithmVersion: "heuristic-v2-explicit-topics",
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
    algorithmVersion: "heuristic-v2-explicit-topics",
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
