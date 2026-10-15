import type { ReadingEvent, RankingExposure } from "./readflux-client.ts";
import {
  deriveInterestProfile,
  RECOMMENDATION_ALGORITHM_VERSION,
  recommendationDiagnostics,
  scoreRecommendation,
} from "./recommendation.ts";
import { localDayKey } from "./smart-feeds.mjs";
import { storyTextForEntry } from "./story-text.ts";

export const RECOMMENDATION_EXPORT_FORMAT = "readflux-recommendation-export";
export const RECOMMENDATION_EXPORT_VERSION = 1;

export type ExportableEntry = {
  id: number;
  feed_id: number;
  status: "read" | "unread" | "removed";
  title: string;
  url: string;
  content: string;
  published_at: string;
  changed_at?: string;
  starred: boolean;
  updated?: boolean;
  reading_time?: number;
};

export type ExportableFeed = {
  id: number;
  title: string;
  category?: { id: number; title: string };
};

export function buildRecommendationExport(input: {
  exportedAt: string;
  timeZone: string;
  markReadOnScroll: boolean;
  entries: ExportableEntry[];
  feeds: ExportableFeed[];
  events: ReadingEvent[];
  exposures: RankingExposure[];
}) {
  // Derive from the export-time event set; the list's captured profile can predate WebDAV mirrors.
  const profileNow = new Date(input.exportedAt).getTime();
  const profile = deriveInterestProfile(
    input.events,
    input.entries.filter((entry) => entry.starred).map((entry) => ({ feedId: entry.feed_id })),
    profileNow,
  );
  const referenced = new Set<number>();
  input.events.forEach((event) => referenced.add(event.entryId));
  input.exposures.forEach((exposure) => exposure.items.forEach((item) => referenced.add(item.entryId)));
  // Unread, updated, and starred entries form the current Today candidate pool.
  const entries = input.entries
    .filter((entry) => referenced.has(entry.id) || entry.starred || entry.updated || entry.status === "unread")
    .sort((a, b) => b.published_at.localeCompare(a.published_at) || b.id - a.id)
    .map((entry) => {
      const { recommendationText } = storyTextForEntry(entry);
      return {
        id: entry.id,
        feedId: entry.feed_id,
        title: entry.title,
        url: entry.url,
        publishedAt: entry.published_at,
        changedAt: entry.changed_at,
        status: entry.status,
        starred: entry.starred,
        updated: entry.updated ?? false,
        readingTime: entry.reading_time,
        recommendationText,
        currentScore: scoreRecommendation({
          feedId: entry.feed_id,
          text: recommendationText,
          publishedAt: entry.published_at,
          starred: entry.starred,
          now: profileNow,
          profile,
        }),
      };
    });
  const byWeight = <K>(map: Map<K, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]);
  return {
    format: RECOMMENDATION_EXPORT_FORMAT,
    formatVersion: RECOMMENDATION_EXPORT_VERSION,
    exportedAt: input.exportedAt,
    algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
    timeZone: input.timeZone,
    settings: { markReadOnScroll: input.markReadOnScroll },
    profile: {
      derivedAt: input.exportedAt,
      sources: byWeight(profile.sources).map(([feedId, weight]) => ({ feedId, weight })),
      terms: byWeight(profile.words).map(([term, weight]) => ({ term, weight })),
      negatives: byWeight(profile.negatives).map(([term, weight]) => ({ term, weight })),
    },
    diagnostics: recommendationDiagnostics(input.exposures, input.events),
    feeds: input.feeds.map((feed) => ({
      id: feed.id,
      title: feed.title,
      categoryId: feed.category?.id,
      categoryTitle: feed.category?.title,
    })),
    events: [...input.events].sort((a, b) => a.openedAt.localeCompare(b.openedAt)),
    exposures: [...input.exposures].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    entries,
  };
}

export function withActiveReadingEvent(events: ReadingEvent[], active: ReadingEvent | null) {
  if (!active) return events;
  return [...events.filter((event) => event.remoteClientId !== undefined || event.id !== active.id), { ...active }];
}

export function recommendationExportFileName(exportedAt: string, timeZone: string) {
  return `readflux-recommendation-${localDayKey(exportedAt, timeZone)}.json`;
}
