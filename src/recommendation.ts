import type { ReadingEvent, RankingExposure } from "./readflux-client.ts";
import { normalizeRecommendationTerm } from "./recommendation-terms.ts";

export const RECOMMENDATION_ALGORITHM_VERSION = "heuristic-v5-seen-impressions";
export const RANKING_EXPOSURE_LIMIT = 100;

export const RECENCY_DAYS = 28;
export const MIN_ENGAGED_SECONDS = 5;
const MIN_ENGAGED_SCROLL = 0.15;
const FULL_SCROLL_CREDIT_MINUTES = 10;
const ENGAGEMENT_PRIOR_EVENTS = 3;
const MIN_ENGAGEMENT_PRIOR = 0.01;
const OPEN_RATE_PRIOR_IMPRESSIONS = 20;
const MAX_SOURCE_SCORE = 20;

export type SourceAffinity = {
  feedId: number;
  readingWeight: number;
  readingQuality: number;
  engagement: number;
  impressions: number;
  opens: number;
  openRate: number;
  stars: number;
  starWeight: number;
  affinity: number;
  relativeAffinity: number;
};

export type SourceBaseline = {
  engagement: number;
  openRate: number;
  affinity: number;
};

export type InterestProfile = {
  sources: Map<number, SourceAffinity>;
  sourceBaseline: SourceBaseline | null;
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

type WeightedTermMatcher = {
  term: string;
  weight: number;
  matches: (text: string) => boolean;
};

const profileTermMatchers = new WeakMap<InterestProfile, WeightedTermMatcher[]>();

export type RankingCandidate = {
  entryId: number;
  feedId?: number;
  publishedAt?: string;
  breakdown: RecommendationScoreBreakdown;
  statusPriority: number;
};

const round = (value: number) => Math.round(value * 1000) / 1000;

type StarredDocument = { feedId: number; entryId?: number };

type SourceTotals = {
  readingWeight: number;
  readingQuality: number;
  impressions: number;
  opens: number;
  stars: number;
};

export function recencyWeight(at: number, now: number) {
  return Math.exp(-Math.max(0, (now - at) / 86_400_000) / RECENCY_DAYS);
}

export function readingEventQuality(
  event: Pick<ReadingEvent, "activeSeconds" | "scrollDepth" | "readingTime" | "feedback">,
) {
  if (event.feedback === "helpful") return 1;
  const minutes = Number.isFinite(event.readingTime) ? Math.max(1, event.readingTime ?? 1) : 1;
  const activeSeconds = Math.max(0, event.activeSeconds);
  const completion = Math.min(1, activeSeconds / (minutes * 60));
  const scrollCredit = Math.max(0, Math.min(1, event.scrollDepth))
    * Math.min(1, minutes / FULL_SCROLL_CREDIT_MINUTES);
  if (activeSeconds < MIN_ENGAGED_SECONDS && scrollCredit < MIN_ENGAGED_SCROLL) return 0;
  return Math.max(completion, scrollCredit);
}

export function isEngagedReadingEvent(
  event: Pick<ReadingEvent, "activeSeconds" | "scrollDepth" | "readingTime" | "feedback">,
) {
  return readingEventQuality(event) > 0;
}

function attributedOpenKey(rankingId: string, entryId: number) {
  return `${rankingId}\n${entryId}`;
}

export function deriveSourceAffinities(
  events: ReadingEvent[],
  starred: StarredDocument[],
  now: number,
  options: { exposures?: RankingExposure[]; entryFeedIds?: ReadonlyMap<number, number> } = {},
): { sources: Map<number, SourceAffinity>; baseline: SourceBaseline | null } {
  const totals = new Map<number, SourceTotals>();
  const totalsFor = (feedId: number) => {
    let current = totals.get(feedId);
    if (!current) {
      current = { readingWeight: 0, readingQuality: 0, impressions: 0, opens: 0, stars: 0 };
      totals.set(feedId, current);
    }
    return current;
  };
  const latestStarMark = new Map<number, { at: number; starred: boolean }>();
  const attributedOpens = new Set<string>();

  events.forEach((event) => {
    if (event.starredAt) {
      const starredAt = new Date(event.starredAt).getTime();
      const current = latestStarMark.get(event.entryId);
      if (Number.isFinite(starredAt) && (!current || starredAt > current.at)) {
        latestStarMark.set(event.entryId, { at: starredAt, starred: event.starred === true });
      }
    }
    if (event.feedback === "not_interested") return;
    if (event.rankingId && event.exposedRank !== undefined) {
      attributedOpens.add(attributedOpenKey(event.rankingId, event.entryId));
    }
    const openedAt = new Date(event.openedAt).getTime();
    if (!Number.isFinite(openedAt)) return;
    const weight = recencyWeight(openedAt, now);
    const current = totalsFor(event.feedId);
    current.readingWeight += weight;
    current.readingQuality += weight * readingEventQuality(event);
  });

  options.exposures?.forEach((exposure) => {
    const createdAt = new Date(exposure.createdAt).getTime();
    if (!Number.isFinite(createdAt)) return;
    const weight = recencyWeight(createdAt, now);
    const seen = exposure.seenEntryIds ? new Set(exposure.seenEntryIds) : null;
    exposure.items.forEach((item) => {
      const feedId = item.feedId ?? options.entryFeedIds?.get(item.entryId);
      if (feedId === undefined) return;
      const opened = attributedOpens.has(attributedOpenKey(exposure.id, item.entryId));
      if (seen && !opened && !seen.has(item.entryId)) return;
      const current = totalsFor(feedId);
      // Exposures without viewport tracking estimate examination from rank.
      current.impressions += seen ? weight : weight / Math.log2(Math.max(1, item.rank) + 1);
      if (opened) current.opens += weight;
    });
  });

  starred.forEach((document) => {
    const mark = document.entryId === undefined ? undefined : latestStarMark.get(document.entryId);
    totalsFor(document.feedId).stars += mark?.starred ? recencyWeight(mark.at, now) : 1;
  });

  const sources = new Map<number, SourceAffinity>();
  if (!totals.size) return { sources, baseline: null };
  let readingWeight = 0;
  let readingQuality = 0;
  let impressions = 0;
  let opens = 0;
  totals.forEach((current) => {
    readingWeight += current.readingWeight;
    readingQuality += current.readingQuality;
    impressions += current.impressions;
    opens += current.opens;
  });
  const engagementPrior = readingWeight > 0
    ? Math.max(MIN_ENGAGEMENT_PRIOR, readingQuality / readingWeight)
    : 0.5;
  // Without any attributed opens, open rate carries no signal and must not zero every feed.
  const openRateKnown = opens > 0;
  const openRatePrior = openRateKnown ? opens / impressions : 1;
  const baseline = {
    engagement: engagementPrior,
    openRate: openRatePrior,
    affinity: engagementPrior * openRatePrior,
  };
  totals.forEach((current, feedId) => {
    const starWeight = Math.log1p(current.stars);
    const engagement = (current.readingQuality + starWeight + ENGAGEMENT_PRIOR_EVENTS * engagementPrior)
      / (current.readingWeight + starWeight + ENGAGEMENT_PRIOR_EVENTS);
    const openRate = openRateKnown
      ? (current.opens + OPEN_RATE_PRIOR_IMPRESSIONS * openRatePrior) / (current.impressions + OPEN_RATE_PRIOR_IMPRESSIONS)
      : 1;
    const affinity = engagement * openRate;
    sources.set(feedId, {
      feedId,
      ...current,
      engagement,
      openRate,
      starWeight,
      affinity,
      relativeAffinity: affinity / baseline.affinity,
    });
  });
  return { sources, baseline };
}

export function clampRecommendationScore(unclampedScore: number) {
  return Math.max(1, Math.min(99, Math.round(unclampedScore)));
}

export function sourceScoreForAffinity(relativeAffinity: number) {
  const relative = Math.max(0, relativeAffinity);
  return round(MAX_SOURCE_SCORE * relative / (1 + relative));
}

export function isPreferredSource(profile: InterestProfile, feedId: number) {
  const source = profile.sources.get(feedId);
  return !!source && source.readingQuality > 0 && source.relativeAffinity >= 1.5;
}

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
  return selectedTopicTermsByEntry(events).get(entryId) ?? new Set<string>();
}

export function selectedTopicTermsByEntry(events: ReadingEvent[]) {
  const selected = new Map<number, Set<string>>();
  foldTopicFeedback(events).forEach((operation) => {
    if (!operation.interested) return;
    const terms = selected.get(operation.entryId) ?? new Set<string>();
    terms.add(operation.term);
    selected.set(operation.entryId, terms);
  });
  return selected;
}

export function deriveInterestProfile(
  events: ReadingEvent[],
  starred: StarredDocument[],
  now: number,
  options: { exposures?: RankingExposure[]; entryFeedIds?: ReadonlyMap<number, number> } = {},
): InterestProfile {
  const { sources, baseline } = deriveSourceAffinities(events, starred, now, options);
  const words = new Map<string, number>();
  const negatives = new Map<string, number>();
  foldTopicFeedback(events).forEach((operation) => {
    if (!operation.interested) return;
    const selectedAt = new Date(operation.updatedAt).getTime();
    if (!Number.isFinite(selectedAt)) return;
    words.set(operation.term, 1);
  });
  return { sources, sourceBaseline: baseline, words, negatives };
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
  const hits = termMatchersForProfile(input.profile)
    .filter(({ matches }) => matches(normalizedText));
  const source = input.profile.sources.get(input.feedId);
  const sourceScore = sourceScoreForAffinity(source ? source.relativeAffinity : input.profile.sourceBaseline ? 1 : 0);
  const termSignal = hits.reduce((sum, { weight }) => sum + Math.log1p(weight), 0);
  const termScore = round(Math.min(24, 9 * Math.log1p(termSignal)));
  const publishedAt = new Date(input.publishedAt).getTime();
  const ageDays = Number.isFinite(publishedAt) ? Math.max(0, (input.now - publishedAt) / 86_400_000) : 12;
  const freshnessScore = round(Math.max(0, 12 - ageDays));
  const savedBonus = input.starred ? 8 : 0;
  const negativePenalty = 0;
  const unclampedScore = round(40 + sourceScore + termScore + freshnessScore + savedBonus);
  return {
    score: clampRecommendationScore(unclampedScore),
    unclampedScore,
    sourceScore,
    termScore,
    freshnessScore,
    savedBonus,
    negativePenalty,
    matchedTerms: hits.slice(0, 3).map(({ term }) => term),
  };
}

function termMatchersForProfile(profile: InterestProfile) {
  const cached = profileTermMatchers.get(profile);
  if (cached) return cached;

  const matchers = [...profile.words.entries()]
    .filter(([, weight]) => weight > 0)
    .map(([termValue, weight]) => {
      const term = normalizeRecommendationTerm(termValue);
      if (!term) return null;
      if (/\p{Script=Han}/u.test(term)) {
        return { term, weight, matches: (text: string) => text.includes(term) };
      }
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "u");
      return { term, weight, matches: (text: string) => pattern.test(text) };
    })
    .filter((matcher): matcher is WeightedTermMatcher => matcher !== null)
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term));
  profileTermMatchers.set(profile, matchers);
  return matchers;
}

export function createRankingExposure(input: {
  id: string;
  createdAt: string;
  candidateCount: number;
  candidates: RankingCandidate[];
  limit?: number;
}): RankingExposure {
  const candidates = input.candidates.slice(0, input.limit ?? RANKING_EXPOSURE_LIMIT);
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
      ...(candidate.feedId !== undefined ? { feedId: candidate.feedId } : {}),
      ...(candidate.publishedAt ? { publishedAt: candidate.publishedAt } : {}),
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
    seenEntryIds: [],
  };
}

export function recordSeenEntries(exposure: RankingExposure, entryIds: Iterable<number>): RankingExposure {
  const seen = new Set(exposure.seenEntryIds ?? []);
  const exposed = new Set(exposure.items.map((item) => item.entryId));
  const added = [...entryIds].filter((entryId) => exposed.has(entryId) && !seen.has(entryId));
  if (!added.length) return exposure;
  return { ...exposure, seenEntryIds: [...seen, ...new Set(added)] };
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
  const engaged = attributed.filter(isEngagedReadingEvent);
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
  const attributedKeys = new Set(attributed.map((event) => `${event.rankingId}:${event.entryId}`));
  const engagedKeySet = new Set(engaged.map((event) => `${event.rankingId}:${event.entryId}`));
  const seenTracked = exposures.filter((exposure) => exposure.seenEntryIds);
  const seenKeys = new Set(seenTracked.flatMap((exposure) => exposure.items
    .filter((item) => exposure.seenEntryIds?.includes(item.entryId) || attributedKeys.has(`${exposure.id}:${item.entryId}`))
    .map((item) => `${exposure.id}:${item.entryId}`)));
  const seenOpens = [...seenKeys].filter((key) => attributedKeys.has(key)).length;
  const seenEngaged = [...seenKeys].filter((key) => engagedKeySet.has(key)).length;
  const seen = {
    trackedExposures: seenTracked.length,
    impressions: seenKeys.size,
    opens: seenOpens,
    engagedOpens: seenEngaged,
    openPercent: seenKeys.size ? seenOpens / seenKeys.size * 100 : 0,
    engagedOpenPercent: seenKeys.size ? seenEngaged / seenKeys.size * 100 : 0,
  };
  const evaluationAtK = [5, 10, 20, 50, 100].map((k) => {
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
    seen,
  };
}
