export const SUPPORTED_LANGUAGES = ["en", "zh-CN", "fr"] as const;
export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === "string" && SUPPORTED_LANGUAGES.includes(value as SupportedLanguage);
}

export function normalizeLanguage(value?: string): SupportedLanguage {
  if (!value) return "en";
  const exact = SUPPORTED_LANGUAGES.find((language) => language.toLowerCase() === value.toLowerCase());
  if (exact) return exact;
  const base = value.split("-")[0].toLowerCase();
  return SUPPORTED_LANGUAGES.find((language) => language.toLowerCase().split("-")[0] === base) ?? "en";
}
