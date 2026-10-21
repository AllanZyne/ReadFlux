import { useEffect, useRef, useState } from "react";
import {
  aiContentHash,
  AiRequestError,
  aiResultKey,
  chunkSegments,
  parseTranslationSegments,
  streamAiCompletion,
  stripCodeFence,
  summaryPrompt,
  translationPrompt,
  type AiConfig,
  type AiTargetLanguage,
  type AiTask,
} from "./ai-client";
import { applyTranslation, articlePlainText, prepareTranslation, serializeTranslation } from "./ai-translation";
import { getAiResult, putAiResult } from "./readflux-client";

export type AiArticle = { id: number; title: string; content: string };

type AiResultScope = { entryId: number; language: AiTargetLanguage };

export type ArticleSummary = AiResultScope & {
  status: "loading" | "streaming" | "done" | "error";
  text: string;
  error?: unknown;
  open: boolean;
};

export type ArticleTranslation = AiResultScope & {
  status: "loading" | "translating" | "done";
  /** Translated HTML; partially translated while `status` is "translating". */
  html: string;
  done: number;
  total: number;
  showing: boolean;
};

const inScope = <T extends AiResultScope>(value: T | null, article: AiArticle | null, language: AiTargetLanguage) =>
  value && article && value.entryId === article.id && value.language === language ? value : null;

async function savedResult(article: AiArticle, task: AiTask, language: AiTargetLanguage, contentHash: string) {
  const record = await getAiResult(aiResultKey(article.id, task, language)).catch(() => null);
  return record?.contentHash === contentHash ? record.text : null;
}

function saveResult(config: AiConfig, article: AiArticle, task: AiTask, language: AiTargetLanguage, contentHash: string, text: string) {
  void putAiResult({
    key: aiResultKey(article.id, task, language),
    entryId: article.id,
    task,
    language,
    contentHash,
    model: config.model,
    text,
    createdAt: new Date().toISOString(),
  }).catch(() => undefined);
}

/**
 * Summary and translation state for the open article. Results are saved per
 * entry, task, and language, and reused while the article content is
 * unchanged; `force` regenerates and replaces a saved result.
 */
export function useArticleAi(
  config: AiConfig | null,
  article: AiArticle | null,
  language: AiTargetLanguage,
  onTranslationError: (cause: unknown) => void,
) {
  const [summaryState, setSummaryState] = useState<ArticleSummary | null>(null);
  const [translationState, setTranslationState] = useState<ArticleTranslation | null>(null);
  const summaryRun = useRef<AbortController | null>(null);
  const translationRun = useRef<AbortController | null>(null);
  const articleId = article?.id;

  useEffect(() => () => {
    summaryRun.current?.abort();
    translationRun.current?.abort();
  }, [articleId, language, config]);

  const summary = inScope(summaryState, article, language);
  const translation = inScope(translationState, article, language);

  const runSummary = async (activeConfig: AiConfig, target: AiArticle, force: boolean) => {
    summaryRun.current?.abort();
    const controller = new AbortController();
    summaryRun.current = controller;
    const update = (next: Pick<ArticleSummary, "status" | "text" | "error">) => {
      if (!controller.signal.aborted) setSummaryState({ entryId: target.id, language, open: true, ...next });
    };
    update({ status: "loading", text: "" });
    try {
      const contentHash = await aiContentHash(`${target.title}\n${target.content}`);
      const saved = force ? null : await savedResult(target, "summary", language, contentHash);
      if (saved !== null) return update({ status: "done", text: saved });
      if (controller.signal.aborted) return;
      const prompt = summaryPrompt(target.title, articlePlainText(target.content), language);
      const result = await streamAiCompletion(activeConfig, prompt, {
        signal: controller.signal,
        onText: (text) => update({ status: "streaming", text }),
      });
      if (controller.signal.aborted) return;
      update({ status: "done", text: result.text });
      saveResult(activeConfig, target, "summary", language, contentHash, result.text);
    } catch (cause) {
      update({ status: "error", text: "", error: cause });
    }
  };

  const runTranslation = async (activeConfig: AiConfig, target: AiArticle, force: boolean) => {
    translationRun.current?.abort();
    const controller = new AbortController();
    translationRun.current = controller;
    const update = (next: Pick<ArticleTranslation, "status" | "html" | "done" | "total">) => {
      if (!controller.signal.aborted) setTranslationState({ entryId: target.id, language, showing: true, ...next });
    };
    update({ status: "loading", html: "", done: 0, total: 0 });
    try {
      const contentHash = await aiContentHash(`${target.title}\n${target.content}`);
      const saved = force ? null : await savedResult(target, "translation", language, contentHash);
      if (saved !== null) return update({ status: "done", html: saved, done: 1, total: 1 });
      const prepared = prepareTranslation(target.content);
      if (!prepared.blocks.length) throw new AiRequestError("empty");
      const chunks = chunkSegments(prepared.blocks.map((block) => block.source));
      update({ status: "translating", html: serializeTranslation(prepared), done: 0, total: chunks.length });
      for (const [index, chunk] of chunks.entries()) {
        const prompt = translationPrompt(chunk.map((blockIndex) => prepared.blocks[blockIndex].source), language);
        const result = await streamAiCompletion(activeConfig, prompt, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const segments = parseTranslationSegments(result.text);
        if (!segments.size && chunk.length === 1) segments.set(1, stripCodeFence(result.text).trim());
        chunk.forEach((blockIndex, position) => {
          const translated = segments.get(position + 1);
          if (translated) applyTranslation(prepared.blocks[blockIndex], translated);
        });
        update({ status: "translating", html: serializeTranslation(prepared), done: index + 1, total: chunks.length });
      }
      const html = serializeTranslation(prepared, true);
      update({ status: "done", html, done: chunks.length, total: chunks.length });
      saveResult(activeConfig, target, "translation", language, contentHash, html);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setTranslationState(null);
      onTranslationError(cause);
    }
  };

  const toggleSummary = (force = false) => {
    if (!config || !article) return;
    if (summary && (summary.status === "loading" || summary.status === "streaming")) {
      summaryRun.current?.abort();
      setSummaryState(null);
      return;
    }
    if (!force && summary?.status === "done") return setSummaryState({ ...summary, open: !summary.open });
    if (!force && summary?.status === "error") return setSummaryState(null);
    void runSummary(config, article, force);
  };

  const toggleTranslation = (force = false) => {
    if (!config || !article) return;
    if (translation && translation.status !== "done") {
      translationRun.current?.abort();
      setTranslationState(null);
      return;
    }
    if (!force && translation) return setTranslationState({ ...translation, showing: !translation.showing });
    void runTranslation(config, article, force);
  };

  const retrySummary = () => {
    if (config && article) void runSummary(config, article, true);
  };

  return { summary, translation, toggleSummary, toggleTranslation, retrySummary };
}
