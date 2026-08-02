import i18next, { createInstance, type i18n } from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json" with { type: "json" };
import fr from "./locales/fr.json" with { type: "json" };
import zhCN from "./locales/zh-CN.json" with { type: "json" };
import { normalizeLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from "./languages.ts";

export { isSupportedLanguage, normalizeLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from "./languages.ts";

const resources = {
  en: { translation: en },
  "zh-CN": { translation: zhCN },
  fr: { translation: fr },
};

function options(language: SupportedLanguage) {
  return {
    resources,
    lng: language,
    fallbackLng: "en",
    supportedLngs: [...SUPPORTED_LANGUAGES],
    interpolation: { escapeValue: false },
    initImmediate: false,
  } as const;
}

export function createReadFluxI18n(language: SupportedLanguage): i18n {
  const instance = createInstance();
  void instance.init(options(language));
  return instance;
}

const browserLanguage = typeof navigator === "undefined" ? "en" : navigator.language;

function updateDocument(language: string) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = normalizeLanguage(language);
  document.querySelector<HTMLMetaElement>('meta[name="description"]')
    ?.setAttribute("content", i18next.t("meta.description"));
}

i18next.on("languageChanged", updateDocument);
void i18next.use(initReactI18next).init(options(normalizeLanguage(browserLanguage))).then(() => {
  updateDocument(i18next.resolvedLanguage ?? "en");
});

export default i18next;
