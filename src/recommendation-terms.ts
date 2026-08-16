export const TERM_EXTRACTION_VERSION = "candidate-v1";

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

const URL_OR_EMAIL = /(?:https?:\/\/|www\.)\S+|\b[^\s@]+@[^\s@]+\.[^\s@]+\b/giu;
const HTML_REMNANT = /<[^>]*>|&(?:[a-z]+|#\d+);/giu;
const PURE_YEAR = /^(?:19|20)\d{2}$/;
const HAS_SIGNAL = /[\p{L}\p{N}]/u;
const HAN = /\p{Script=Han}/u;

export function normalizeRecommendationTerm(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function tokenize(value: string) {
  const cleaned = value.normalize("NFKC").replace(URL_OR_EMAIL, " ").replace(HTML_REMNANT, " ");
  const rough = cleaned.toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:[+#-][\p{L}\p{N}+#-]*)?/gu) ?? [];
  if (!HAN.test(cleaned)) return rough;
  if (typeof Intl.Segmenter !== "function") {
    const hanFallback = (cleaned.match(/\p{Script=Han}+/gu) ?? []).flatMap((run) => {
      if (run.length <= 2) return [run];
      return Array.from({ length: run.length - 1 }, (_, index) => run.slice(index, index + 2));
    });
    return [...rough.filter((term) => !HAN.test(term)), ...hanFallback];
  }
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  const segmented = [...segmenter.segment(cleaned)]
    .filter((part) => part.isWordLike)
    .map((part) => normalizeRecommendationTerm(part.segment));
  return [...rough.filter((term) => !HAN.test(term)), ...segmented];
}

export function extractRecommendationTerms(value: string, limit = 80) {
  const terms = tokenize(value)
    .map(normalizeRecommendationTerm)
    .filter((term) => HAS_SIGNAL.test(term)
      && !UNIVERSAL_IGNORED.has(term)
      && !ENGLISH_IGNORED.has(term)
      && !CHINESE_IGNORED.has(term)
      && !PURE_YEAR.test(term)
      && (HAN.test(term) || term.length >= 2));
  return [...new Set(terms)].slice(0, limit);
}
