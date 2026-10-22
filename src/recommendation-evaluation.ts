import type { RankingExposure, ReadingEvent } from "./readflux-client.ts";
import {
  clampRecommendationScore,
  deriveInterestProfile,
  isEngagedReadingEvent,
  RECOMMENDATION_ALGORITHM_VERSION,
  scoreRecommendation,
} from "./recommendation.ts";
import { localDayKey } from "./smart-feeds.mjs";

export const DEEP_READ_SECONDS = 30;
export const DUPLICATE_EXPOSURE_WINDOW_MS = 10 * 60_000;

export type EvaluationEntry = {
  id: number;
  feedId: number;
  publishedAt: string;
  starred: boolean;
  recommendationText?: string;
};

export type EvaluationInput = {
  timeZone: string;
  events: ReadingEvent[];
  exposures: RankingExposure[];
  entries: EvaluationEntry[];
  /** Evaluate only exposures created at or after this time; earlier data still builds profiles. */
  since?: number;
};

export type EvaluationLabel = "opened" | "engaged" | "deep";

type Scorer = "recorded" | "replayed" | "replayedSource" | "replayedTerm" | "recordedTerm" | "freshness";

type Row = {
  group: string;
  labels: Record<EvaluationLabel, boolean>;
  scores: Record<Scorer, number>;
};

export type AucResult = { auc: number | null; pairs: number; tieShare: number };

const SCORERS: Scorer[] = ["recorded", "replayed", "replayedSource", "replayedTerm", "recordedTerm", "freshness"];
const LABELS: EvaluationLabel[] = ["opened", "engaged", "deep"];

const clientOf = (exposure: RankingExposure) => exposure.remoteClientId ?? "local";

export function dedupeExposures(exposures: RankingExposure[]) {
  const sorted = [...exposures].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const kept: RankingExposure[] = [];
  const aliases = new Map<string, string>();
  const lastByClient = new Map<string, number>();
  sorted.forEach((exposure) => {
    const previousIndex = lastByClient.get(clientOf(exposure));
    const previous = previousIndex === undefined ? undefined : kept[previousIndex];
    const sameItems = previous
      && previous.items.length === exposure.items.length
      && previous.items.every((item, index) => item.entryId === exposure.items[index].entryId);
    const withinWindow = previous
      && new Date(exposure.createdAt).getTime() - new Date(previous.createdAt).getTime() <= DUPLICATE_EXPOSURE_WINDOW_MS;
    if (previous && previousIndex !== undefined && sameItems && withinWindow) {
      aliases.set(exposure.id, previous.id);
      const union = (a?: number[], b?: number[]) => a || b ? [...new Set([...(a ?? []), ...(b ?? [])])] : undefined;
      kept[previousIndex] = {
        ...previous,
        seenEntryIds: union(previous.seenEntryIds, exposure.seenEntryIds),
        bulkDismissedEntryIds: union(previous.bulkDismissedEntryIds, exposure.bulkDismissedEntryIds),
      };
      return;
    }
    lastByClient.set(clientOf(exposure), kept.length);
    kept.push(exposure);
  });
  return { exposures: kept, aliases };
}

export function pairwiseAuc(rows: { group: string; label: boolean; score: number }[]): AucResult {
  const groups = new Map<string, { positives: number[]; negatives: number[] }>();
  rows.forEach((row) => {
    const group = groups.get(row.group) ?? { positives: [], negatives: [] };
    (row.label ? group.positives : group.negatives).push(row.score);
    groups.set(row.group, group);
  });
  let wins = 0;
  let ties = 0;
  let pairs = 0;
  groups.forEach(({ positives, negatives }) => positives.forEach((positive) => negatives.forEach((negative) => {
    pairs += 1;
    if (Math.abs(positive - negative) < 1e-9) ties += 1;
    else if (positive > negative) wins += 1;
  })));
  return {
    auc: pairs ? (wins + ties / 2) / pairs : null,
    pairs,
    tieShare: pairs ? ties / pairs : 0,
  };
}

const timeOf = (value: string) => new Date(value).getTime();

export function historicalEvents(events: ReadingEvent[], at: number) {
  const opened = events
    .filter((event) => timeOf(event.openedAt) < at)
    .map((event) => event.topicFeedback
      ? { ...event, topicFeedback: event.topicFeedback.filter((operation) => timeOf(operation.updatedAt) < at) }
      : event);
  return {
    // Exports hold only each event's final state, so events changed after the cutoff are left out.
    readingEvents: opened.filter((event) => timeOf(event.updatedAt) < at),
    topicEvents: opened,
  };
}

export function evaluateRecommendations(input: EvaluationInput) {
  const { exposures, aliases } = dedupeExposures(input.exposures);
  const entries = new Map(input.entries.map((entry) => [entry.id, entry]));
  const remapped = input.events.map((event) => {
    const alias = event.rankingId ? aliases.get(event.rankingId) : undefined;
    return alias ? { ...event, rankingId: alias } : event;
  });
  const attributed = new Map<string, ReadingEvent[]>();
  remapped.forEach((event) => {
    if (!event.rankingId || event.exposedRank === undefined) return;
    const key = `${event.rankingId}\n${event.entryId}`;
    attributed.set(key, [...(attributed.get(key) ?? []), event]);
  });
  const entryFeedIds = new Map(input.entries.map((entry) => [entry.id, entry.feedId]));
  const entryTexts = new Map(input.entries.flatMap((entry) => entry.recommendationText ? [[entry.id, entry.recommendationText] as const] : []));

  const rows: Row[] = [];
  let items = 0;
  let evaluable = 0;
  let knownText = 0;
  let activeExposures = 0;
  let seenTracked = 0;
  exposures.forEach((exposure) => {
    const keyFor = (entryId: number) => `${exposure.id}\n${entryId}`;
    const at = new Date(exposure.createdAt).getTime();
    if (input.since !== undefined && !(at >= input.since)) return;
    if (!exposure.items.some((item) => attributed.has(keyFor(item.entryId)))) return;
    activeExposures += 1;
    const seen = exposure.seenEntryIds ? new Set(exposure.seenEntryIds) : null;
    if (seen) seenTracked += 1;
    const history = historicalEvents(input.events, at);
    // De-duplicated records carry later observations, so profiles replay the original exposures.
    const priorExposures = input.exposures.filter((prior) => new Date(prior.createdAt).getTime() < at);
    // Only the current starred set is exported; count entries published before the exposure.
    const stars = input.entries
      .filter((entry) => entry.starred && new Date(entry.publishedAt).getTime() < at)
      .map((entry) => ({ feedId: entry.feedId, entryId: entry.id }));
    const profile = deriveInterestProfile(history.readingEvents, stars, at, {
      exposures: priorExposures,
      entryFeedIds,
      entryTexts,
      topicEvents: history.topicEvents,
    });
    exposure.items.forEach((item) => {
      const opened = attributed.get(keyFor(item.entryId)) ?? [];
      if (seen && !opened.length && !seen.has(item.entryId)) return;
      items += 1;
      const entry = entries.get(item.entryId);
      const feedId = item.feedId ?? entry?.feedId;
      const publishedAt = item.publishedAt ?? entry?.publishedAt;
      if (feedId === undefined || !publishedAt) return;
      evaluable += 1;
      if (entry?.recommendationText) knownText += 1;
      const replayed = scoreRecommendation({
        feedId,
        text: entry?.recommendationText ?? "",
        publishedAt,
        starred: !!entry?.starred && new Date(publishedAt).getTime() < at,
        now: at,
        profile,
      });
      const termScore = entry?.recommendationText ? replayed.termScore : item.termScore;
      rows.push({
        group: `${exposure.id}\n${item.statusPriority}\n${localDayKey(publishedAt, input.timeZone)}`,
        labels: {
          opened: opened.length > 0,
          engaged: opened.some(isEngagedReadingEvent),
          deep: opened.some((event) => event.activeSeconds >= DEEP_READ_SECONDS),
        },
        scores: {
          recorded: item.score,
          replayed: clampRecommendationScore(replayed.unclampedScore - replayed.termScore + termScore),
          replayedSource: replayed.sourceScore,
          replayedTerm: termScore,
          recordedTerm: item.termScore,
          freshness: new Date(publishedAt).getTime(),
        },
      });
    });
  });

  const metrics = Object.fromEntries(LABELS.map((label) => [label, {
    positives: rows.filter((row) => row.labels[label]).length,
    ...Object.fromEntries(SCORERS.map((scorer) => [scorer, pairwiseAuc(rows.map((row) => ({
      group: row.group,
      label: row.labels[label],
      score: row.scores[scorer],
    })))])),
  }])) as Record<EvaluationLabel, { positives: number } & Record<Scorer, AucResult>>;

  return {
    algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
    exposures: {
      total: input.exposures.length,
      afterDeduplication: exposures.length,
      withAttributedOpens: activeExposures,
      seenTracked,
    },
    coverage: { items, evaluable, knownText },
    metrics,
  };
}
