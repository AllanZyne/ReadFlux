export const TERM_RULES_VERSION = "2026-08-15";

export type TermRuleAction = "ignore" | "keep" | "remove";

export type TermRuleOperation = {
  id: string;
  clientId: string;
  term: string;
  action: TermRuleAction;
  updatedAt: string;
};

export type EffectiveTermRules = Map<string, Exclude<TermRuleAction, "remove">>;

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
const LATIN = /\p{Script=Latin}/u;

export function normalizeRecommendationTerm(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

export function foldTermRules(operations: TermRuleOperation[]): EffectiveTermRules {
  const latest = new Map<string, TermRuleOperation>();
  for (const operation of operations) {
    const term = normalizeRecommendationTerm(operation.term);
    if (!term) continue;
    const current = latest.get(term);
    if (!current || `${operation.updatedAt}\n${operation.id}` > `${current.updatedAt}\n${current.id}`) {
      latest.set(term, { ...operation, term });
    }
  }
  const result: EffectiveTermRules = new Map();
  latest.forEach((operation, term) => {
    if (operation.action !== "remove") result.set(term, operation.action);
  });
  return result;
}

function languageDefaults(tokens: string[]) {
  let han = 0;
  let latin = 0;
  let englishEvidence = 0;
  tokens.forEach((token) => {
    if (HAN.test(token)) han += 1;
    if (LATIN.test(token)) latin += 1;
    if (ENGLISH_IGNORED.has(token)) englishEvidence += 1;
  });
  if (han > latin) return CHINESE_IGNORED;
  if (latin > 0 && englishEvidence > 0) return ENGLISH_IGNORED;
  return null;
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

function accepted(term: string, defaults: Set<string> | null, rules: EffectiveTermRules) {
  const override = rules.get(term);
  if (override === "ignore") return false;
  if (!HAS_SIGNAL.test(term) || UNIVERSAL_IGNORED.has(term) || PURE_YEAR.test(term)) return false;
  if (override === "keep") return true;
  if (defaults?.has(term)) return false;
  if (!HAN.test(term) && term.length < 2) return false;
  return true;
}

export function extractRecommendationTerms(value: string, rules: EffectiveTermRules = new Map()) {
  const tokens = tokenize(value).map(normalizeRecommendationTerm).filter(Boolean);
  const defaults = languageDefaults(tokens);
  return [...new Set(tokens.filter((term) => accepted(term, defaults, rules)))].slice(0, 80);
}

export function sanitizeRecordedTerms(terms: string[], rules: EffectiveTermRules = new Map()) {
  return extractRecommendationTerms(terms.join(" "), rules);
}

export function explainTermRule(termValue: string, rules: EffectiveTermRules) {
  const term = normalizeRecommendationTerm(termValue);
  const override = rules.get(term);
  if (override) return { term, state: override, reason: "user" as const };
  if (UNIVERSAL_IGNORED.has(term) || PURE_YEAR.test(term) || !HAS_SIGNAL.test(term)) {
    return { term, state: "ignore" as const, reason: "structural" as const };
  }
  if (ENGLISH_IGNORED.has(term)) return { term, state: "ignore" as const, reason: "english" as const };
  if (CHINESE_IGNORED.has(term)) return { term, state: "ignore" as const, reason: "chinese" as const };
  return { term, state: "keep" as const, reason: "normal" as const };
}

export const TERM_LIST_COUNTS = {
  universal: UNIVERSAL_IGNORED.size,
  en: ENGLISH_IGNORED.size,
  zh: CHINESE_IGNORED.size,
};
