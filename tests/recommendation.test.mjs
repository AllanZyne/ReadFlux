import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BASE_SCORE,
  MAX_TERM_SCORE,
  createRankingExposure,
  deriveInterestProfile,
  deriveSourceAffinities,
  extractRecommendationTerms,
  foldTopicFeedback,
  followedTopicTerms,
  isEngagedReadingEvent,
  RANKING_EXPOSURE_LIMIT,
  rankingAttribution,
  readingEventQuality,
  recommendationDiagnostics,
  recordBulkDismissal,
  recordSeenEntries,
  RECOMMENDATION_ALGORITHM_VERSION,
  scoreRecommendation,
  selectedTopicTermsByEntry,
  sourceScoreForAffinity,
  topicWeightForAffinity,
} from "../src/recommendation.ts";
import { extractRecommendationCandidateTerms, normalizeSelectedTopic, prioritizeFollowedTopicTerms } from "../src/recommendation-terms.ts";

const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const termSource = await readFile(new URL("../src/recommendation-terms.ts", import.meta.url), "utf8");
const termWorkerSource = await readFile(new URL("../src/recommendation-terms.worker.ts", import.meta.url), "utf8");

const round3 = (value) => Math.round(value * 1000) / 1000;

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

test("followed Chinese topics and English phrases take priority when the article contains them", () => {
  assert.deepEqual(prioritizeFollowedTopicTerms(
    "大语言模型中的 Retrieval Augmented Generation",
    "介绍 OpenAI API 和向量数据库",
    ["语言模型", "retrieval augmented generation", "openai api", "没有出现"],
    ["retrieval", "模型", "向量"],
  ), ["retrieval augmented generation", "语言模型", "openai api", "retrieval", "模型"]);
});

test("followed English topics require complete word boundaries", () => {
  assert.deepEqual(prioritizeFollowedTopicTerms(
    "Said and repainted",
    "C++20 compiler internals",
    ["ai", "paint", "c++20", "compiler internals"],
    ["compiler", "internals"],
  ), ["compiler internals", "c++20", "compiler", "internals"]);
});

test("followed-topic priority is capped and deterministic", () => {
  assert.deepEqual(prioritizeFollowedTopicTerms(
    "alpha beta gamma delta epsilon zeta",
    "",
    ["zeta", "beta", "epsilon", "alpha", "delta", "gamma"],
    ["fallback"],
  ), ["epsilon", "alpha", "delta", "gamma", "beta"]);
});

test("manual topic selection accepts short terms and rejects sentences or noisy values", () => {
  assert.equal(normalizeSelectedTopic("  大语言模型  "), "大语言模型");
  assert.equal(normalizeSelectedTopic("Retrieval Augmented Generation"), "retrieval augmented generation");
  assert.equal(normalizeSelectedTopic("跨越\n段落"), null);
  assert.equal(normalizeSelectedTopic("这是一整句话。"), null);
  assert.equal(normalizeSelectedTopic("https://example.com/topic"), null);
  assert.equal(normalizeSelectedTopic("42"), null);
});

test("article opening delegates Jieba extraction and dictionary warmup to a worker", () => {
  assert.match(appSource, /terms:\s*\[\][\s\S]*?extractRecommendationCandidateTermsAsync/);
  assert.match(appSource, /const initialPersistence = putReadingEvent\(readingEvent\)[\s\S]*?await initialPersistence/);
  assert.match(termSource, /new Worker\(new URL\("\.\/recommendation-terms\.worker\.ts"/);
  assert.match(termWorkerSource, /tag\("中文分词预热", true\)/);
});

test("topic toggles derive current state from the active event", () => {
  assert.match(appSource, /const currentEvent = activeEvent\.current[\s\S]*?followedTopicTerms\([\s\S]*?currentEvent[\s\S]*?interested: addToCandidates \|\| !currentlySelected/);
});

test("following selected text is idempotent and checks the global follow state", () => {
  assert.match(appSource, /const requestTopicSelection = useCallback[\s\S]*?followedTopics\.has\(term\)/);
  assert.match(appSource, /const followSelectedTopic = async \(\) => \{\s*const selection = topicSelection;\s*if \(!selection\) return;\s*dismissTopicSelection\(\);\s*await toggleTopicInterest\(selection\.term, true\);/);
  assert.match(appSource, /term: normalizedTerm/);
});

test("selected article text uses the existing topic operation and persists as a candidate", () => {
  assert.match(appSource, /onTextSelection=\{requestTopicSelection\}/);
  assert.match(appSource, /<ArticleMetadata[\s\S]*?onTextSelection=\{requestTopicSelection\}/);
  assert.match(appSource, /<h2[\s\S]*?onMouseUp=\{\(event\) => captureTextSelection\(event\.currentTarget, onTextSelection\)\}/);
  assert.match(appSource, /className="topicSelectionConfirm"[\s\S]*?recommendation\.followSelectedTopic/);
  assert.match(appSource, /toggleTopicInterest\(selection\.term, true\)/);
  assert.match(appSource, /const terms = addToCandidates[\s\S]*?\[normalizedTerm,\s*\.\.\.currentEvent\.terms\]/);
  assert.match(appSource, /prioritizeFollowedTopicTerms\([\s\S]*?interest\.words\.keys\(\)[\s\S]*?new Set\(\[\.\.\.activeEvent\.current\.terms,\s*\.\.\.prioritizedTerms\]\)/);
});

test("background extraction handles persistence failures and avoids sorting event history", () => {
  assert.match(appSource, /extractRecommendationCandidateTermsAsync[\s\S]*?\.catch\(\(\) => \{/);
  assert.match(appSource, /events\.reduce<ReadingEvent \| undefined>/);
  assert.doesNotMatch(appSource, /events\.filter\(\(event\) => event\.entryId === selected\.id\)\.sort/);
});

test("raw reading events default to the 30 most recent while search covers all events", () => {
  assert.match(appSource, /matchingEvents = \[\.\.\.events\][\s\S]*?b\.openedAt\.localeCompare\(a\.openedAt\)/);
  assert.match(appSource, /shownEvents = normalizedEventQuery \? matchingEvents : matchingEvents\.slice\(0, 30\)/);
  assert.doesNotMatch(appSource, /recommendation\.addRecord|emptyEventDraft/);
  assert.doesNotMatch(appSource, /diagnosticGrid|recommendation\.(?:scoreDistribution|componentDistribution|engagementByRank|evaluationAtK)/);
});

test("reading and saving never imply topic interest", () => {
  const profile = deriveInterestProfile([event({ terms: ["llvm"] })], [
    { feedId: 2, text: "LLVM" },
  ], Date.parse("2026-08-14T00:00:00.000Z"));
  assert.equal(profile.words.size, 0);
  assert.ok((profile.sources.get(2)?.readingQuality ?? 0) > 0);
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

test("explicit topic weights stay fixed at one across repeated selections and time", () => {
  const profile = deriveInterestProfile([
    event({
      entryId: 1,
      topicFeedback: [{ id: "old", term: "LLVM", interested: true, updatedAt: "2025-01-01T00:00:00.000Z" }],
    }),
    event({
      id: "event-2",
      entryId: 2,
      topicFeedback: [{ id: "new", term: "llvm", interested: true, updatedAt: "2026-08-14T00:00:00.000Z" }],
    }),
  ], [], Date.parse("2026-08-14T02:00:00.000Z"));
  assert.equal(profile.words.size, 1);
  assert.equal(profile.words.get("llvm"), 1);
});

test("the latest topic choice from any article decides whether it is followed", () => {
  const followedInFirst = event({
    entryId: 1,
    topicFeedback: [{ id: "a", term: "LLVM", interested: true, updatedAt: "2026-08-14T00:00:00.000Z" }],
  });
  const unfollowedInSecond = event({
    id: "event-2",
    entryId: 2,
    topicFeedback: [{ id: "b", term: "llvm", interested: false, updatedAt: "2026-08-14T01:00:00.000Z" }],
  });
  const now = Date.parse("2026-08-14T02:00:00.000Z");
  assert.deepEqual([...followedTopicTerms([followedInFirst])], ["llvm"]);
  assert.deepEqual([...followedTopicTerms([followedInFirst, unfollowedInSecond])], []);
  assert.equal(deriveInterestProfile([followedInFirst, unfollowedInSecond], [], now).words.size, 0);
  const followedAgain = event({
    id: "event-3",
    entryId: 3,
    topicFeedback: [{ id: "c", term: "llvm", interested: true, updatedAt: "2026-08-14T02:00:00.000Z" }],
  });
  assert.equal(deriveInterestProfile([followedInFirst, unfollowedInSecond, followedAgain], [], now).words.get("llvm"), 1);
});

test("followed topics are weighted by reading depth and Today open rate, and unfollowed terms get none", () => {
  const now = Date.parse("2026-08-14T02:00:00.000Z");
  const follow = (term) => ({ id: `follow-${term}`, term, interested: true, updatedAt: "2026-08-13T00:00:00.000Z" });
  const read = (id, entryId, terms, overrides = {}) => event({ id, entryId, terms, title: terms.join(" "), ...overrides });
  const events = [
    read("e1", 1, ["llvm"], { topicFeedback: [follow("llvm"), follow("rust")] }),
    read("e2", 2, ["llvm"]),
    read("e3", 3, ["llvm"]),
    read("e4", 4, ["rust"], { activeSeconds: 2, scrollDepth: 0 }),
    read("e5", 5, ["rust"], { activeSeconds: 2, scrollDepth: 0 }),
    read("e6", 6, ["python"]),
  ];
  const profile = deriveInterestProfile(events, [], now);
  assert.deepEqual([...profile.followedTerms].sort(), ["llvm", "rust"]);
  assert.equal(profile.words.has("python"), false, "terms that are not followed get no weight");
  const llvm = profile.topics.get("llvm");
  const rust = profile.topics.get("rust");
  assert.ok(llvm.weight > 1 && llvm.weight < 2, "deeply read topics weigh more than a neutral topic");
  assert.ok(rust.weight < 1, "topics that are opened but not read weigh less");
  assert.equal(topicWeightForAffinity(1), 1);
  const unread = deriveInterestProfile([event({ terms: ["llvm"], topicFeedback: [follow("zig")] })], [], now);
  assert.equal(unread.topics.get("zig").weight, 1, "a followed topic without reads stays neutral");
});

test("topic affinity does not depend on the order of an article's events", () => {
  const now = Date.parse("2026-08-14T02:00:00.000Z");
  const follow = { id: "follow", term: "rust", interested: true, updatedAt: "2026-08-13T00:00:00.000Z" };
  const withoutTerms = event({ id: "a", entryId: 7, terms: [], title: "Systems notes", topicFeedback: [follow] });
  const withTerms = event({ id: "b", entryId: 7, terms: ["rust"], title: "Systems notes", openedAt: "2026-08-14T01:00:00.000Z" });
  const exposure = {
    id: "ranking",
    createdAt: "2026-08-13T12:00:00.000Z",
    seenEntryIds: [7],
    items: [{ entryId: 7, rank: 1, feedId: 2 }],
  };
  const topic = (events) => deriveInterestProfile(events, [], now, { exposures: [exposure] }).topics.get("rust");
  assert.deepEqual(topic([withoutTerms, withTerms]), topic([withTerms, withoutTerms]));
  assert.ok(topic([withoutTerms, withTerms]).readingWeight > 1.9, "both reads of the article mention the topic");
});

test("score breakdowns list every matched topic", () => {
  const profile = {
    sources: new Map(),
    sourceBaseline: null,
    words: new Map(["llvm", "rust", "zig", "wasm"].map((term) => [term, 1])),
    negatives: new Map(),
  };
  const breakdown = scoreRecommendation({
    feedId: 1,
    text: "LLVM Rust Zig WASM",
    publishedAt: "2026-08-14T00:00:00.000Z",
    starred: false,
    now: Date.parse("2026-08-14T00:00:00.000Z"),
    profile,
  });
  assert.equal(breakdown.matchedTerms.length, 4);
});

test("followed topics that are seen in Today but skipped lose weight", () => {
  const now = Date.parse("2026-08-14T02:00:00.000Z");
  const follow = { id: "follow", term: "rust", interested: true, updatedAt: "2026-08-13T00:00:00.000Z" };
  const opened = event({ id: "open", entryId: 1, terms: ["llvm"], title: "LLVM", rankingId: "ranking", exposedRank: 1, topicFeedback: [follow] });
  const exposure = {
    id: "ranking",
    createdAt: "2026-08-14T00:00:00.000Z",
    seenEntryIds: [1, 2, 3, 4],
    items: [1, 2, 3, 4].map((entryId, index) => ({ entryId, rank: index + 1, feedId: 2 })),
  };
  const entryTexts = new Map([[1, "LLVM"], [2, "Rust async"], [3, "Rust traits"], [4, "Rust macros"]]);
  const profile = deriveInterestProfile([opened], [], now, { exposures: [exposure], entryTexts });
  const rust = profile.topics.get("rust");
  assert.equal(rust.opens, 0);
  assert.ok(rust.impressions > 2.9);
  assert.ok(rust.weight < 1);
});

test("topic matches stay below the feed component", () => {
  const profile = {
    sources: new Map(),
    sourceBaseline: { engagement: 0.5, openRate: 1, affinity: 0.5 },
    words: new Map([["llvm", 1]]),
    negatives: new Map(),
  };
  const breakdown = scoreRecommendation({
    feedId: 9,
    text: "LLVM",
    publishedAt: "2026-08-01T00:00:00.000Z",
    starred: false,
    now: Date.parse("2026-08-14T00:00:00.000Z"),
    profile,
  });
  assert.ok(breakdown.termScore > 4 && breakdown.termScore < 5, "one neutral topic adds about 4.4 points");
  assert.ok(MAX_TERM_SCORE < sourceScoreForAffinity(Number.MAX_SAFE_INTEGER) + 0.1, "the topic cap stays within the feed range");
  assert.equal(breakdown.unclampedScore, round3(BASE_SCORE + breakdown.sourceScore + breakdown.termScore));
});

test("invalid explicit-topic timestamps do not receive maximum weight", () => {
  const profile = deriveInterestProfile([event({
    topicFeedback: [{ id: "invalid", term: "llvm", interested: true, updatedAt: "not-a-date" }],
  })], [], Date.parse("2026-08-14T02:00:00.000Z"));
  assert.equal(profile.words.size, 0);
});

test("selected topics are folded once into an entry lookup", () => {
  const selected = selectedTopicTermsByEntry([
    event({ entryId: 1, topicFeedback: [{ id: "a", term: "LLVM", interested: true, updatedAt: "2026-08-14T00:00:00.000Z" }] }),
    event({ id: "event-2", entryId: 2, topicFeedback: [{ id: "b", term: "Rust", interested: true, updatedAt: "2026-08-14T00:00:00.000Z" }] }),
  ]);
  assert.deepEqual([...selected.get(1) ?? []], ["llvm"]);
  assert.deepEqual([...selected.get(2) ?? []], ["rust"]);
});

test("source scores map relative affinity onto a bounded scale and keep term discrimination", () => {
  const profile = {
    sources: new Map([[2, { feedId: 2, relativeAffinity: 10_000 }], [3, { feedId: 3, relativeAffinity: 0 }]]),
    sourceBaseline: { engagement: 0.2, openRate: 0.5, affinity: 0.1 },
    words: new Map([["llvm", 10_000]]),
    negatives: new Map(),
  };
  const score = (feedId, currentProfile = profile) => scoreRecommendation({
    feedId,
    text: "LLVM compiler internals",
    publishedAt: "2026-08-14T00:00:00.000Z",
    starred: false,
    now: Date.parse("2026-08-14T00:00:00.000Z"),
    profile: currentProfile,
  });
  const breakdown = score(2);
  assert.ok(breakdown.sourceScore > 19.9 && breakdown.sourceScore < 20);
  assert.equal(score(3).sourceScore, 0);
  assert.equal(score(99).sourceScore, 10);
  assert.equal(score(99, { ...profile, sources: new Map(), sourceBaseline: null }).sourceScore, 0);
  assert.equal(sourceScoreForAffinity(1), 10);
  assert.ok(breakdown.termScore > 11.9 && breakdown.termScore <= 12);
  assert.ok(breakdown.unclampedScore < 99);
  assert.equal(breakdown.score, Math.round(breakdown.unclampedScore));
  assert.equal(RECOMMENDATION_ALGORITHM_VERSION, "heuristic-v7-topic-affinity");
});

test("reading quality normalizes foreground time by expected length", () => {
  assert.equal(readingEventQuality({ activeSeconds: 30, scrollDepth: 1, readingTime: 1 }), 0.5);
  assert.equal(readingEventQuality({ activeSeconds: 120, scrollDepth: 0.2, readingTime: 10 }), 0.2);
  assert.equal(readingEventQuality({ activeSeconds: 0, scrollDepth: 1, readingTime: 10 }), 1);
  assert.equal(readingEventQuality({ activeSeconds: 600, scrollDepth: 0, readingTime: 4 }), 1);
  assert.equal(readingEventQuality({ activeSeconds: 30, scrollDepth: 0 }), 0.5);
  assert.equal(readingEventQuality({ activeSeconds: 0, scrollDepth: 0, feedback: "helpful" }), 1);
});

test("short-post scrolling is discounted and the bounce threshold suits quantized and precise seconds", () => {
  assert.equal(readingEventQuality({ activeSeconds: 0, scrollDepth: 1, readingTime: 1 }), 0);
  assert.equal(isEngagedReadingEvent({ activeSeconds: 0, scrollDepth: 1, readingTime: 1 }), false);
  assert.equal(isEngagedReadingEvent({ activeSeconds: 4.9, scrollDepth: 0.5, readingTime: 1 }), false);
  assert.equal(isEngagedReadingEvent({ activeSeconds: 5, scrollDepth: 0, readingTime: 1 }), true);
  assert.equal(isEngagedReadingEvent({ activeSeconds: 0, scrollDepth: 0.3, readingTime: 6 }), true);
});

test("source affinity rewards depth rather than event volume", () => {
  const now = Date.parse("2026-08-14T00:00:00.000Z");
  const shallow = Array.from({ length: 100 }, (_, index) => event({
    id: `shallow-${index}`,
    entryId: 1000 + index,
    feedId: 10,
    activeSeconds: index % 2 ? 0 : 5,
    scrollDepth: 1,
    readingTime: 1,
  }));
  const deep = Array.from({ length: 5 }, (_, index) => event({
    id: `deep-${index}`,
    entryId: 2000 + index,
    feedId: 20,
    activeSeconds: 240,
    scrollDepth: 1,
    readingTime: 4,
  }));
  const { sources, baseline } = deriveSourceAffinities([...shallow, ...deep], [], now);
  assert.ok(sources.get(20).relativeAffinity > 1);
  assert.ok(sources.get(10).relativeAffinity < 1);
  assert.ok(sources.get(20).engagement > sources.get(10).engagement);
  assert.ok(baseline.engagement > 0 && baseline.engagement < 1);
});

test("feeds shown often but rarely opened lose affinity through smoothed open rates", () => {
  const now = Date.parse("2026-08-14T00:00:00.000Z");
  const item = (entryId, rank, feedId) => ({
    entryId,
    ...(feedId === undefined ? {} : { feedId }),
    rank,
    score: 50,
    sourceScore: 0,
    termScore: 0,
    freshnessScore: 0,
    savedBonus: 0,
    negativePenalty: 0,
    statusPriority: 1,
    matchedTerms: [],
  });
  const exposures = Array.from({ length: 20 }, (_, index) => ({
    id: `ranking-${index}`,
    createdAt: "2026-08-13T00:00:00.000Z",
    algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
    schemaVersion: 2,
    surface: "today",
    candidateCount: 2,
    displayedCount: 2,
    items: [item(index * 2 + 1, 1, 30), item(index * 2 + 2, 2)],
  }));
  const reads = [
    ...Array.from({ length: 20 }, (_, index) => event({
      id: `open-${index}`,
      entryId: index * 2 + 2,
      feedId: 40,
      activeSeconds: 60,
      readingTime: 1,
      rankingId: `ranking-${index}`,
      exposedRank: 2,
    })),
    ...Array.from({ length: 20 }, (_, index) => event({
      id: `other-${index}`,
      entryId: 500 + index,
      feedId: 30,
      activeSeconds: 60,
      readingTime: 1,
      origin: "feed",
    })),
  ];
  const entryFeedIds = new Map(exposures.map((exposure) => [exposure.items[1].entryId, 40]));
  const { sources } = deriveSourceAffinities(reads, [], now, { exposures, entryFeedIds });
  const ignored = sources.get(30);
  const opened = sources.get(40);
  assert.equal(ignored.opens, 0);
  assert.ok(ignored.impressions > opened.impressions);
  assert.ok(opened.opens > 19 && opened.opens < 20);
  assert.ok(ignored.openRate < opened.openRate);
  assert.ok(ignored.relativeAffinity < opened.relativeAffinity);
  assert.ok(ignored.openRate > 0);
  const dismissed = reads.map((read) => read.rankingId ? { ...read, feedback: "not_interested" } : read);
  assert.equal(deriveSourceAffinities(dismissed, [], now, { exposures, entryFeedIds }).sources.get(40).opens, 0);
});

test("saved articles add diminishing source credit and decay by recorded save time", () => {
  const now = Date.parse("2026-08-14T00:00:00.000Z");
  const reading = [event({ feedId: 50, activeSeconds: 6, readingTime: 1 }), event({ id: "b", entryId: 9, feedId: 60, activeSeconds: 6, readingTime: 1 })];
  const many = Array.from({ length: 31 }, (_, index) => ({ feedId: 50, entryId: 100 + index }));
  const { sources } = deriveSourceAffinities(reading, [...many, { feedId: 60, entryId: 200 }], now);
  assert.equal(sources.get(50).stars, 31);
  assert.equal(sources.get(50).starWeight, Math.log1p(31));
  assert.ok(sources.get(50).starWeight < 4);
  assert.ok(sources.get(50).engagement < 1);

  const starredEvent = event({
    id: "starred",
    entryId: 300,
    feedId: 70,
    activeSeconds: 6,
    readingTime: 1,
    starred: true,
    starredAt: "2026-06-19T00:00:00.000Z",
  });
  const decayed = deriveSourceAffinities([starredEvent], [{ feedId: 70, entryId: 300 }], now).sources.get(70);
  assert.ok(Math.abs(decayed.stars - Math.exp(-2)) < 1e-9);
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
    candidateCount: 120,
    candidates: Array.from({ length: 120 }, (_, index) => ({ entryId: index + 100, breakdown, statusPriority: 1 })),
  });
  assert.equal(exposure.schemaVersion, 2);
  assert.equal(RANKING_EXPOSURE_LIMIT, 100);
  assert.equal(exposure.displayedCount, 100);
  assert.equal(exposure.items[0].rank, 1);
  assert.equal(exposure.items[99].rank, 100);
  assert.deepEqual(exposure.seenEntryIds, []);
  assert.deepEqual(exposure.items[0].matchedTerms, ["llvm", "compiler", "extra"]);
  assert.deepEqual(rankingAttribution(exposure, 100), {
    rankingId: "ranking-1",
    exposedRank: 1,
    algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
  });
  assert.deepEqual(rankingAttribution(exposure, 999), {});
  assert.equal("feedId" in exposure.items[0], false);
  assert.equal("publishedAt" in exposure.items[0], false);
});

test("new exposure items carry feed and publication metadata for open-rate attribution", () => {
  const exposure = createRankingExposure({
    id: "ranking-2",
    createdAt: "2026-08-15T00:00:00.000Z",
    candidateCount: 1,
    candidates: [{
      entryId: 7,
      feedId: 3,
      publishedAt: "2026-08-14T08:00:00+08:00",
      statusPriority: 1,
      breakdown: { score: 50, unclampedScore: 50, sourceScore: 1, termScore: 0, freshnessScore: 9, savedBonus: 0, negativePenalty: 0, matchedTerms: [] },
    }],
  });
  assert.equal(exposure.schemaVersion, 2);
  assert.equal(exposure.items[0].feedId, 3);
  assert.equal(exposure.items[0].publishedAt, "2026-08-14T08:00:00+08:00");
});

test("the Today snapshot captures exposures with events so background pulls do not rescore", () => {
  assert.match(appSource, /const recommendationSnapshot = useMemo\(\(\) => \(\{[\s\S]*?exposures: recommendationExposures,[\s\S]*?\}\), \[activeTimeZone, hideRead, listOrderVersion, listReadSnapshot, mode, query, topic\]\)/);
  assert.match(appSource, /deriveInterestProfile\([\s\S]*?exposures: recommendationSnapshot\.exposures,[\s\S]*?entryFeedIds:/);
  assert.match(appSource, /feedId: story\.feed_id,\s*publishedAt: story\.published_at,/);
});

test("seen tracking keeps only new exposed entries and returns the same exposure when unchanged", () => {
  const breakdown = { score: 50, unclampedScore: 50, sourceScore: 10, termScore: 0, freshnessScore: 0, savedBonus: 0, negativePenalty: 0, matchedTerms: [] };
  const exposure = createRankingExposure({
    id: "ranking-seen",
    createdAt: "2026-08-15T00:00:00.000Z",
    candidateCount: 3,
    candidates: [1, 2, 3].map((entryId) => ({ entryId, breakdown, statusPriority: 1 })),
  });
  const seen = recordSeenEntries(exposure, [2, 2, 999]);
  assert.deepEqual(seen.seenEntryIds, [2]);
  assert.deepEqual(recordSeenEntries(seen, [3, 2]).seenEntryIds, [2, 3]);
  assert.equal(recordSeenEntries(seen, [2, 999]), seen);
  assert.deepEqual(seen.items, exposure.items);
});

test("seen exposures count only seen or opened items as impressions", () => {
  const now = Date.parse("2026-08-14T00:00:00.000Z");
  const item = (entryId, rank, feedId) => ({ entryId, feedId, rank, score: 50, sourceScore: 0, termScore: 0, freshnessScore: 0, savedBonus: 0, negativePenalty: 0, statusPriority: 1, matchedTerms: [] });
  const exposure = (seenEntryIds) => ({
    id: "ranking-1",
    createdAt: "2026-08-14T00:00:00.000Z",
    algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
    schemaVersion: 2,
    surface: "today",
    candidateCount: 4,
    displayedCount: 4,
    items: [item(1, 1, 10), item(2, 2, 10), item(3, 3, 20), item(4, 4, 20)],
    ...(seenEntryIds ? { seenEntryIds } : {}),
  });
  const open = event({ id: "open", entryId: 4, feedId: 20, rankingId: "ranking-1", exposedRank: 4, openedAt: "2026-08-14T00:00:00.000Z" });

  const tracked = deriveSourceAffinities([open], [], now, { exposures: [exposure([1, 2])] }).sources;
  assert.equal(tracked.get(10).impressions, 2);
  assert.equal(tracked.get(20).impressions, 1);
  assert.equal(tracked.get(20).opens, 1);

  const untracked = deriveSourceAffinities([open], [], now, { exposures: [exposure()] }).sources;
  assert.ok(Math.abs(untracked.get(10).impressions - (1 + 1 / Math.log2(3))) < 1e-9);

  const nothingSeen = deriveSourceAffinities([], [], now, { exposures: [exposure([])] }).sources;
  assert.equal(nothingSeen.get(10), undefined);
});

test("feeds keep depth and saved-article differences when no Today item was ever opened", () => {
  const now = Date.parse("2026-08-14T00:00:00.000Z");
  const item = (entryId, rank, feedId) => ({ entryId, feedId, rank, score: 50, sourceScore: 0, termScore: 0, freshnessScore: 0, savedBonus: 0, negativePenalty: 0, statusPriority: 1, matchedTerms: [] });
  const exposures = [{
    id: "unopened",
    createdAt: "2026-08-13T00:00:00.000Z",
    algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
    schemaVersion: 2,
    surface: "today",
    candidateCount: 4,
    displayedCount: 4,
    items: [item(1, 1, 10), item(2, 2, 10), item(3, 3, 20), item(4, 4, 20)],
  }];
  const reads = [
    event({ id: "deep", entryId: 50, feedId: 10, origin: "feed", activeSeconds: 120, readingTime: 2 }),
    event({ id: "bounce", entryId: 60, feedId: 20, origin: "feed", activeSeconds: 0, scrollDepth: 0, readingTime: 5 }),
  ];
  const { sources, baseline } = deriveSourceAffinities(reads, [], now, { exposures });
  assert.equal(baseline.openRate, 1);
  assert.equal(sources.get(10).openRate, 1);
  assert.ok(sources.get(10).relativeAffinity > sources.get(20).relativeAffinity);
  assert.ok(sourceScoreForAffinity(sources.get(10).relativeAffinity) > sourceScoreForAffinity(sources.get(20).relativeAffinity));

  const bouncedOnly = deriveSourceAffinities([reads[1]], [{ feedId: 30, entryId: 70 }], now, { exposures });
  assert.ok(bouncedOnly.baseline.affinity > 0);
  assert.ok(bouncedOnly.sources.get(30).relativeAffinity > bouncedOnly.sources.get(20).relativeAffinity);
});

test("diagnostics report open rates among seen items, counting opened items as seen", () => {
  const breakdown = { score: 50, unclampedScore: 50, sourceScore: 10, termScore: 0, freshnessScore: 0, savedBonus: 0, negativePenalty: 0, matchedTerms: [] };
  const tracked = recordSeenEntries(createRankingExposure({
    id: "tracked",
    createdAt: "2026-08-15T00:00:00.000Z",
    candidateCount: 4,
    candidates: [1, 2, 3, 4].map((entryId) => ({ entryId, breakdown, statusPriority: 1 })),
  }), [1, 2]);
  const untracked = { ...tracked, id: "untracked", seenEntryIds: undefined };
  const events = [
    event({ id: "a", entryId: 2, rankingId: "tracked", exposedRank: 2 }),
    event({ id: "b", entryId: 4, rankingId: "tracked", exposedRank: 4, activeSeconds: 0, scrollDepth: 0 }),
  ];
  const { seen, evaluationAtK } = recommendationDiagnostics([tracked, untracked], events);
  assert.deepEqual(seen, { trackedExposures: 1, impressions: 3, opens: 2, engagedOpens: 1, openPercent: 2 / 3 * 100, engagedOpenPercent: 1 / 3 * 100 });
  assert.deepEqual(evaluationAtK.map(({ k }) => k), [5, 10, 20, 50, 100]);
});

test("the list flushes viewport-seen entries into the exposure before a new exposure replaces it", () => {
  assert.match(appSource, /new IntersectionObserver\([\s\S]*?\{ root: list, threshold: SEEN_VISIBLE_RATIO \}\)/);
  assert.match(appSource, /record\.isIntersecting && record\.intersectionRatio >= SEEN_VISIBLE_RATIO/);
  assert.match(appSource, /if \(document\.visibilityState === "visible"\) qualifying\.forEach\(startDwell\);\s*else \[\.\.\.dwellTimers\.keys\(\)\]\.forEach\(stopDwell\);/);
  assert.match(appSource, /capturedVisibleOrder\.current = frozenVisibleOrder\.ids;\s*flushSeenEntries\(\);/);
  assert.match(appSource, /visible\.slice\(0, RANKING_EXPOSURE_LIMIT\)/);
});

test("bulk dismissal records only exposed Top 100 items without changing scores", () => {
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
    candidateCount: 110,
    candidates: Array.from({ length: 110 }, (_, index) => ({ entryId: index + 1, breakdown, statusPriority: 1 })),
  });
  const updated = recordBulkDismissal(exposure, [2, 100, 101, 999], "2026-08-15T01:00:00.000Z");
  assert.deepEqual(updated.bulkDismissedEntryIds, [2, 100]);
  assert.equal(updated.bulkDismissedAt, "2026-08-15T01:00:00.000Z");
  assert.deepEqual(updated.items, exposure.items);
});

test("diagnostics use matching exposure items rather than opens as their denominator", () => {
  const exposure = {
    id: "ranking-1",
    createdAt: "2026-08-14T00:00:00.000Z",
    algorithmVersion: "heuristic-v3-fixed-topic-weights",
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
