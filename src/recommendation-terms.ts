export const FALLBACK_TERM_EXTRACTION_VERSION = "candidate-v2-intl";
export const JIEBA_TERM_EXTRACTION_VERSION = "candidate-v2-jieba";

type JiebaTag = { word: string; tag: string };
type WorkerResponse = {
  id: number;
  ok: boolean;
  titleTags?: JiebaTag[];
  summaryTags?: JiebaTag[];
};
type WorkerRequest =
  | { type: "initialize" }
  | { type: "extract"; title: string; summary: string };

let jiebaWorker: Worker | null = null;
let jiebaRequestId = 0;
const jiebaRequests = new Map<number, { resolve: (response: WorkerResponse) => void; reject: (cause: Error) => void }>();
const candidateCache = new Map<string, Promise<ExtractedRecommendationCandidates>>();

const UNIVERSAL_IGNORED = new Set([
  "http", "https", "www", "com", "org", "net", "html", "htm", "php",
  "pdf", "amp", "nbsp", "quot", "slides", "slide", "download",
]);

const ENGLISH_IGNORED = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for",
  "from", "has", "have", "he", "her", "his", "how", "i", "if", "in", "into",
  "is", "it", "its", "more", "not", "of", "on", "or", "our", "she", "so",
  "that", "the", "their", "them", "then", "there", "these", "they", "this",
  "to", "was", "we", "were", "what", "when", "where", "which", "who", "why",
  "will", "with", "you", "your",
]);

const CHINESE_IGNORED = new Set([
  "的", "了", "和", "是", "在", "与", "及", "或", "而", "也", "都", "就", "有",
  "为", "这", "那", "一个", "我们", "你们", "他们", "以及", "通过", "关于",
]);

const DATE_WORDS = new Set([
  "jan", "january", "feb", "february", "mar", "march", "apr", "april", "may", "jun", "june",
  "jul", "july", "aug", "august", "sep", "sept", "september", "oct", "october", "nov", "november",
  "dec", "december", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

const URL_OR_EMAIL = /(?:https?:\/\/|www\.)\S+|\b[^\s@]+@[^\s@]+\.[^\s@]+\b/giu;
const HTML_REMNANT = /<[^>]*>|&(?:[a-z]+|#\d+);/giu;
const DATE_OR_TIME = /\b(?:19|20)\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?(?:[t\s]\d{1,2}:\d{2}(?::\d{2})?)?|\b\d{1,2}[-/.月]\d{1,2}(?:[-/.]\d{2,4}|日)?|\b\d{1,2}:\d{2}(?::\d{2})?\b/giu;
const PURE_NUMERIC = /^\p{N}+(?:[.,:/+-]\p{N}+)*%?$/u;
const HAS_SIGNAL = /[\p{L}\p{N}]/u;
const HAN = /\p{Script=Han}/u;
const ONLY_HAN = /^\p{Script=Han}+$/u;

function workerRequest(request: WorkerRequest) {
  if (typeof Worker !== "function") return Promise.reject(new Error("Web Workers are unavailable"));
  if (!jiebaWorker) {
    jiebaWorker = new Worker(new URL("./recommendation-terms.worker.ts", import.meta.url), { type: "module" });
    jiebaWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const pending = jiebaRequests.get(event.data.id);
      if (!pending) return;
      jiebaRequests.delete(event.data.id);
      if (event.data.ok) pending.resolve(event.data);
      else pending.reject(new Error("Jieba worker failed"));
    };
    jiebaWorker.onerror = () => {
      jiebaRequests.forEach(({ reject }) => reject(new Error("Jieba worker failed")));
      jiebaRequests.clear();
      jiebaWorker?.terminate();
      jiebaWorker = null;
    };
  }
  const id = ++jiebaRequestId;
  return new Promise<WorkerResponse>((resolve, reject) => {
    jiebaRequests.set(id, { resolve, reject });
    jiebaWorker!.postMessage({ ...request, id });
  });
}

export async function initializeChineseRecommendationTerms() {
  try {
    await workerRequest({ type: "initialize" });
    return true;
  } catch {
    return false;
  }
}

export function normalizeRecommendationTerm(value: string) {
  return value.normalize("NFKC").trim().toLowerCase();
}

type CandidateToken = { term: string; tag?: string; index: number };

function fallbackHanTokens(cleaned: string): CandidateToken[] {
  if (typeof Intl.Segmenter !== "function") {
    return (cleaned.match(/\p{Script=Han}+/gu) ?? []).flatMap((run) => {
      if (run.length <= 2) return [{ term: run, index: cleaned.indexOf(run) }];
      return Array.from({ length: run.length - 1 }, (_, index) => ({
        term: run.slice(index, index + 2),
        index: cleaned.indexOf(run) + index,
      }));
    });
  }
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  return [...segmenter.segment(cleaned)]
    .filter((part) => part.isWordLike && HAN.test(part.segment))
    .map((part) => ({ term: part.segment, index: part.index }));
}

function technicalTokens(cleaned: string): CandidateToken[] {
  const normalized = cleaned.toLowerCase();
  const rough = normalized.match(/[\p{Script=Latin}\p{N}]+(?:[+#-][\p{Script=Latin}\p{N}+#-]*)?/gu) ?? [];
  return rough.map((term) => ({ term, index: normalized.indexOf(term) }));
}

function cleanedText(value: string) {
  return value.normalize("NFKC").replace(URL_OR_EMAIL, " ").replace(HTML_REMNANT, " ").replace(DATE_OR_TIME, " ");
}

function tokenize(value: string, jiebaTags?: JiebaTag[]): CandidateToken[] {
  const cleaned = cleanedText(value);
  const nonHan = technicalTokens(cleaned);
  if (!HAN.test(cleaned)) return nonHan;
  const han = jiebaTags
    ? jiebaTags
      .filter((token) => HAN.test(token.word))
      .map((token) => ({ term: token.word, tag: token.tag, index: cleaned.indexOf(token.word) }))
    : fallbackHanTokens(cleaned);
  return [...nonHan, ...han];
}

function accepted(term: string, tag?: string) {
  return HAS_SIGNAL.test(term)
      && !UNIVERSAL_IGNORED.has(term)
      && !ENGLISH_IGNORED.has(term)
      && !CHINESE_IGNORED.has(term)
      && !DATE_WORDS.has(term)
      && !PURE_NUMERIC.test(term)
      && term.length >= 2
      && (!tag || /^(?:n|v|a|eng|l|i|j|z)/.test(tag));
}

function posBoost(tag?: string) {
  if (!tag) return 0;
  if (tag.startsWith("n")) return 1.5;
  if (tag === "eng") return 1.2;
  if (tag.startsWith("v")) return 0.35;
  return 0;
}

function rankRecommendationTerms(fields: Array<{ value: string; weight: number; jiebaTags?: JiebaTag[] }>, limit: number) {
  const ranked = new Map<string, { score: number; firstIndex: number }>();
  fields.forEach((field) => tokenize(field.value, field.jiebaTags).forEach((token) => {
    const term = normalizeRecommendationTerm(token.term);
    if (!accepted(term, token.tag)) return;
    const current = ranked.get(term) ?? { score: 0, firstIndex: token.index };
    const hanLengthBoost = ONLY_HAN.test(term) ? Math.min(0.8, (Array.from(term).length - 2) * 0.2) : 0;
    current.score += field.weight * (1 + posBoost(token.tag) + hanLengthBoost);
    current.firstIndex = Math.min(current.firstIndex, token.index);
    ranked.set(term, current);
  }));
  return [...ranked.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].firstIndex - b[1].firstIndex || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

export function extractRecommendationTerms(value: string, limit = 80) {
  return rankRecommendationTerms([{ value, weight: 1 }], limit);
}

export function extractRecommendationCandidateTerms(title: string, summary: string, limit = 5) {
  return rankRecommendationTerms([
    { value: title, weight: 3 },
    { value: summary, weight: 1 },
  ], limit);
}

export type ExtractedRecommendationCandidates = {
  terms: string[];
  version: string;
};

export function extractRecommendationCandidateTermsAsync(title: string, summary: string, limit = 5) {
  const key = `${limit}\n${title}\n${summary}`;
  const cached = candidateCache.get(key);
  if (cached) return cached;
  const extraction = (HAN.test(title) || HAN.test(summary)
    ? workerRequest({ type: "extract", title: cleanedText(title), summary: cleanedText(summary) }).then((response) => ({
        terms: rankRecommendationTerms([
          { value: title, weight: 3, jiebaTags: response.titleTags },
          { value: summary, weight: 1, jiebaTags: response.summaryTags },
        ], limit),
        version: JIEBA_TERM_EXTRACTION_VERSION,
      }))
    : Promise.resolve({
        terms: extractRecommendationCandidateTerms(title, summary, limit),
        version: FALLBACK_TERM_EXTRACTION_VERSION,
      }))
    .catch(() => ({
      terms: extractRecommendationCandidateTerms(title, summary, limit),
      version: FALLBACK_TERM_EXTRACTION_VERSION,
    }));
  if (candidateCache.size >= 500) candidateCache.delete(candidateCache.keys().next().value ?? "");
  candidateCache.set(key, extraction);
  return extraction;
}
