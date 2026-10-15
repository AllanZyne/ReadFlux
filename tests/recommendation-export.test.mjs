import assert from "node:assert/strict";
import test from "node:test";

import { createRankingExposure, deriveInterestProfile } from "../src/recommendation.ts";
import {
  buildRecommendationExport,
  RECOMMENDATION_EXPORT_FORMAT,
  recommendationExportFileName,
} from "../src/recommendation-export.ts";

const now = Date.parse("2026-10-15T12:00:00.000Z");

const entry = (overrides = {}) => ({
  id: 1,
  feed_id: 10,
  status: "read",
  title: "Entry",
  url: "https://example.com/1",
  content: "<p>Body text</p>",
  published_at: "2026-10-14T00:00:00.000Z",
  starred: false,
  ...overrides,
});

const event = {
  id: "event-1",
  entryId: 1,
  feedId: 10,
  title: "Entry",
  source: "Feed",
  terms: [],
  openedAt: "2026-10-14T08:00:00.000Z",
  activeSeconds: 90,
  scrollDepth: 0.8,
  origin: "recommendation",
  rankingId: "ranking-1",
  exposedRank: 1,
  updatedAt: "2026-10-14T08:00:00.000Z",
};

test("recommendation export keeps referenced and candidate entries without full content", () => {
  const exposure = createRankingExposure({
    id: "ranking-1",
    createdAt: "2026-10-14T07:00:00.000Z",
    candidateCount: 2,
    candidates: [{
      entryId: 2,
      statusPriority: 0,
      breakdown: { score: 50, unclampedScore: 50, sourceScore: 0, termScore: 0, freshnessScore: 10, savedBonus: 0, negativePenalty: 0, matchedTerms: [] },
    }],
  });
  const data = buildRecommendationExport({
    exportedAt: "2026-10-15T12:00:00.000Z",
    timeZone: "UTC",
    markReadOnScroll: true,
    entries: [
      entry(),
      entry({ id: 2, status: "read" }),
      entry({ id: 3, status: "unread" }),
      entry({ id: 4, status: "read", starred: true }),
      entry({ id: 5, status: "read" }),
    ],
    feeds: [{ id: 10, title: "Feed", category: { id: 7, title: "Tech" } }],
    events: [event],
    exposures: [exposure],
  });

  assert.equal(data.format, RECOMMENDATION_EXPORT_FORMAT);
  assert.deepEqual(data.entries.map((item) => item.id).sort(), [1, 2, 3, 4]);
  assert.equal(data.entries[0].recommendationText, "Entry Body text");
  assert.equal("content" in data.entries[0], false);
  assert.equal(data.entries.find((item) => item.id === 1).currentScore.sourceScore > 0, true);
  assert.deepEqual(data.feeds, [{ id: 10, title: "Feed", categoryId: 7, categoryTitle: "Tech" }]);
  assert.equal(data.profile.sources[0].feedId, 10);
  assert.equal(data.diagnostics.exposureCount, 1);
  assert.equal(JSON.stringify(data).includes("apiKey"), false);
});

test("recommendation export derives its profile from every exported event", () => {
  const mirrored = {
    ...event,
    id: "event-2",
    remoteClientId: "other",
    topicFeedback: [{ id: "op-1", term: "LLVM", interested: true, updatedAt: "2026-10-14T08:00:00.000Z" }],
  };
  const data = buildRecommendationExport({
    exportedAt: "2026-10-15T12:00:00.000Z",
    timeZone: "UTC",
    markReadOnScroll: false,
    entries: [entry({ title: "LLVM news", status: "unread" })],
    feeds: [],
    events: [event, mirrored],
    exposures: [],
  });
  const expected = deriveInterestProfile([event, mirrored], [], now);

  assert.deepEqual(data.profile.terms, [{ term: "llvm", weight: 1 }]);
  assert.equal(data.profile.sources[0].weight, expected.sources.get(10));
  assert.equal(data.entries[0].currentScore.termScore > 0, true);
});

test("recommendation export file name uses the reader timezone day", () => {
  assert.equal(
    recommendationExportFileName("2026-10-15T20:00:00.000Z", "Asia/Shanghai"),
    "readflux-recommendation-2026-10-16.json",
  );
});
