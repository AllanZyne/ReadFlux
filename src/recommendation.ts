import type { ReadingEvent, RankingExposure } from "./readflux-client.ts";
import { normalizeRecommendationTerm } from "./recommendation-terms.ts";

export const RECOMMENDATION_ALGORITHM_VERSION = "heuristic-v2-explicit-topics";

export type InterestProfile = {
  sources: Map<number, number>;
  words: Map<string, number>;
  negatives: Map<string, number>;
};

export type RecommendationScoreBreakdown = {
  score: number;
  unclampedScore: number;
  sourceScore: number;
  termScore: number;
  freshnessScore: number;
  savedBonus: number;
  negativePenalty: number;
  matchedTerms: string[];
};

export type RankingCandidate = {
  entryId: number;
  breakdown: RecommendationScoreBreakdown;
  statusPriority: number;
};

const round = (value: number) => Math.round(value * 1000) / 1000;

type StarredDocument = { feedId: number };

export { extractRecommendationTerms } from "./recommendation-terms.ts";

type FoldedTopicFeedback = {
  entryId: number;
  term: string;
  interested: boolean;
  updatedAt: string;
  id: string;
};

export function foldTopicFeedback(events: ReadingEvent[]) {
  const latest = new Map<string, FoldedTopicFeedback>();
  events.forEach((event) => event.topicFeedback?.forEach((operation) => {
    const term = normalizeRecommendationTerm(operation.term);
    if (!term) return;
    const key = `${event.entryId}\n${term}`;
    const candidate = { ...operation, entryId: event.entryId, term };
    const current = latest.get(key);
    if (!current || `${candidate.updatedAt}\n${candidate.id}` > `${current.updatedAt}\n${current.id}`) {
      latest.set(key, candidate);
    }
  }));
  return [...latest.values()];
}

export function selectedTopicTermsForEntry(events: ReadingEvent[], entryId: number) {
  return new Set(foldTopicFeedback(events)
    .filter((operation) => operation.entryId === entryId && operation.interested)
    .map((operation) => operation.term));
}

export function deriveInterestProfile(
  events: ReadingEvent[],
  starred: StarredDocument[],
  now: number,
): InterestProfile {
  const sources = new Map<number, number>();
  const words = new Map<string, number>();
  const negatives = new Map<string, number>();
  events.forEach((event) => {
    const openedAt = new Date(event.openedAt).getTime();
    if (!Number.isFinite(openedAt)) return;
    const ageDays = Math.max(0, (now - openedAt) / 86_400_000);
    const recency = Math.exp(-ageDays / 28);
    const engaged = Math.min(4, event.activeSeconds / 30) + event.scrollDepth * 2;
    const positive = event.feedback === "helpful" ? 5 : engaged;
    if (event.feedback === "not_interested") return;
    if (event.activeSeconds < 6 && event.scrollDepth < 0.15 && event.feedback !== "helpful") return;
    const weight = Math.max(0.2, positive) * recency;
    sources.set(event.feedId, (sources.get(event.feedId) ?? 0) + weight);
  });
  starred.forEach((document) => {
    sources.set(document.feedId, (sources.get(document.feedId) ?? 0) + 5);
  });
  foldTopicFeedback(events).forEach((operation) => {
    if (!operation.interested) return;
    const selectedAt = new Date(operation.updatedAt).getTime();
    const ageDays = Number.isFinite(selectedAt) ? Math.max(0, (now - selectedAt) / 86_400_000) : 0;
    const weight = Math.exp(-ageDays / 90);
    words.set(operation.term, (words.get(operation.term) ?? 0) + weight);
  });
  return { sources, words, negatives };
}

export function scoreRecommendation(input: {
  feedId: number;
  text: string;
  publishedAt: string;
  starred: boolean;
  now: number;
  profile: InterestProfile;
}): RecommendationScoreBreakdown {
  const normalizedText = normalizeRecommendationTerm(input.text);
  const hits = [...input.profile.words.entries()]
    .filter(([term, weight]) => weight > 0 && recommendationTextContainsTerm(normalizedText, term))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const sourceAffinity = input.profile.sources.get(input.feedId) ?? 0;
  const sourceScore = round(Math.min(20, 20 * Math.log1p(sourceAffinity) / Math.log(201)));
  const termSignal = hits.reduce((sum, [, weight]) => sum + Math.log1p(weight), 0);
  const termScore = round(Math.min(24, 9 * Math.log1p(termSignal)));
  const publishedAt = new Date(input.publishedAt).getTime();
  const ageDays = Number.isFinite(publishedAt) ? Math.max(0, (input.now - publishedAt) / 86_400_000) : 12;
  const freshnessScore = round(Math.max(0, 12 - ageDays));
  const savedBonus = input.starred ? 8 : 0;
  const negativePenalty = 0;
  const unclampedScore = round(40 + sourceScore + termScore + freshnessScore + savedBonus);
  return {
    score: Math.max(1, Math.min(99, Math.round(unclampedScore))),
    unclampedScore,
    sourceScore,
    termScore,
    freshnessScore,
    savedBonus,
    negativePenalty,
    matchedTerms: hits.slice(0, 3).map(([term]) => term),
  };
}

function recommendationTextContainsTerm(text: string, termValue: string) {
  const term = normalizeRecommendationTerm(termValue);
  if (!term) return false;
  if (/\p{Script=Han}/u.test(term)) return text.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "u").test(text);
}

export function createRankingExposure(input: {
  id: string;
  createdAt: string;
  candidateCount: number;
  candidates: RankingCandidate[];
  limit?: number;
}): RankingExposure {
  const candidates = input.candidates.slice(0, input.limit ?? 50);
  return {
    id: input.id,
    createdAt: input.createdAt,
    algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
    schemaVersion: 2,
    surface: "today",
    candidateCount: input.candidateCount,
    displayedCount: candidates.length,
    items: candidates.map((candidate, index) => ({
      entryId: candidate.entryId,
      rank: index + 1,
      score: candidate.breakdown.score,
      sourceScore: candidate.breakdown.sourceScore,
      termScore: candidate.breakdown.termScore,
      freshnessScore: candidate.breakdown.freshnessScore,
      savedBonus: candidate.breakdown.savedBonus,
      negativePenalty: candidate.breakdown.negativePenalty,
      statusPriority: candidate.statusPriority,
      matchedTerms: candidate.breakdown.matchedTerms.slice(0, 3),
    })),
  };
}

export function recordBulkDismissal(
  exposure: RankingExposure,
  entryIds: number[],
  occurredAt: string,
): RankingExposure {
  const dismissed = new Set(entryIds);
  const bulkDismissedEntryIds = exposure.items
    .filter((item) => dismissed.has(item.entryId))
    .map((item) => item.entryId);
  if (!bulkDismissedEntryIds.length) return exposure;
  return {
    ...exposure,
    schemaVersion: 2,
    bulkDismissedAt: occurredAt,
    bulkDismissedEntryIds,
  };
}

export function rankingAttribution(exposure: RankingExposure | null, entryId: number) {
  const item = exposure?.items.find((candidate) => candidate.entryId === entryId);
  return exposure && item ? {
    rankingId: exposure.id,
    exposedRank: item.rank,
    algorithmVersion: exposure.algorithmVersion,
  } : {};
}

export function recommendationDiagnostics(exposures: RankingExposure[], events: ReadingEvent[]) {
  const items = exposures.flatMap((exposure) => exposure.items);
  const tied = exposures.reduce((count, exposure) => {
    const frequencies = new Map<number, number>();
    exposure.items.forEach((item) => frequencies.set(item.score, (frequencies.get(item.score) ?? 0) + 1));
    return count + exposure.items.filter((item) => (frequencies.get(item.score) ?? 0) > 1).length;
  }, 0);
  const exposureIds = new Set(exposures.map((exposure) => exposure.id));
  const attributed = events.filter((event) => event.rankingId && exposureIds.has(event.rankingId) && event.exposedRank !== undefined);
  const engaged = attributed.filter((event) => event.activeSeconds >= 6 || event.scrollDepth >= 0.15 || event.feedback === "helpful");
  const summarize = (values: number[]) => ({
    min: values.length ? Math.min(...values) : 0,
    average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
    max: values.length ? Math.max(...values) : 0,
  });
  const scoreRanges = [
    { label: "1–39", min: 1, max: 39 },
    { label: "40–59", min: 40, max: 59 },
    { label: "60–79", min: 60, max: 79 },
    { label: "80–98", min: 80, max: 98 },
    { label: "99", min: 99, max: 99 },
  ];
  const rankEngagement = Array.from({ length: 10 }, (_, index) => {
    const rank = index + 1;
    const impressions = exposures.filter((exposure) => exposure.items.some((item) => item.rank === rank)).length;
    const opens = new Set(attributed.filter((event) => event.exposedRank === rank).map((event) => event.rankingId)).size;
    const engagedOpens = new Set(engaged.filter((event) => event.exposedRank === rank).map((event) => event.rankingId)).size;
    return {
      rank,
      impressions,
      opens,
      engagedOpens,
      engagedOpenPercent: impressions ? engagedOpens / impressions * 100 : 0,
    };
  });
  const evaluationAtK = [5, 10, 20, 50].map((k) => {
    const impressionKeys = new Set(exposures.flatMap((exposure) => exposure.items
      .filter((item) => item.rank <= k)
      .map((item) => `${exposure.id}:${item.entryId}`)));
    const openKeys = new Set(attributed
      .filter((event) => (event.exposedRank ?? Infinity) <= k)
      .map((event) => `${event.rankingId}:${event.entryId}`));
    const engagedKeys = new Set(engaged
      .filter((event) => (event.exposedRank ?? Infinity) <= k)
      .map((event) => `${event.rankingId}:${event.entryId}`));
    const starredKeys = new Set(attributed
      .filter((event) => event.starred === true && (event.exposedRank ?? Infinity) <= k)
      .map((event) => `${event.rankingId}:${event.entryId}`));
    const dismissedKeys = new Set(exposures.flatMap((exposure) => {
      const dismissedIds = new Set(exposure.bulkDismissedEntryIds ?? []);
      return exposure.items
        .filter((item) => item.rank <= k && dismissedIds.has(item.entryId))
        .map((item) => `${exposure.id}:${item.entryId}`);
    }));
    const impressions = impressionKeys.size;
    const rate = (count: number) => impressions ? count / impressions * 100 : 0;
    return {
      k,
      impressions,
      opens: openKeys.size,
      engagedOpens: engagedKeys.size,
      starred: starredKeys.size,
      bulkDismissed: dismissedKeys.size,
      openPercent: rate(openKeys.size),
      engagedOpenPercent: rate(engagedKeys.size),
      starredPercent: rate(starredKeys.size),
      bulkDismissedPercent: rate(dismissedKeys.size),
    };
  });
  return {
    exposureCount: exposures.length,
    displayedCount: items.length,
    clampedPercent: items.length ? items.filter((item) => item.score >= 99).length / items.length * 100 : 0,
    tiePercent: items.length ? tied / items.length * 100 : 0,
    attributedOpenCount: attributed.length,
    engagedOpenCount: engaged.length,
    scoreDistribution: scoreRanges.map((range) => ({
      label: range.label,
      count: items.filter((item) => item.score >= range.min && item.score <= range.max).length,
    })),
    contributions: {
      source: summarize(items.map((item) => item.sourceScore)),
      term: summarize(items.map((item) => item.termScore)),
      freshness: summarize(items.map((item) => item.freshnessScore)),
    },
    rankEngagement,
    evaluationAtK,
  };
}
