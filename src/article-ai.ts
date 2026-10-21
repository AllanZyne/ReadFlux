import { useEffect, useMemo, useRef, useState } from "react";
import {
  aiArticleRevision,
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
import { currentAiResultsGeneration, getAiResult, putAiResult } from "./readflux-client";

export type AiArticle = { id: number; title: string; content: string };

/** Results are valid only for this entry revision, language, and results epoch. */
type AiResultScope = { entryId: number; revision: string; language: AiTargetLanguage; epoch: number };

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

const sameScope = (value: AiResultScope | null, scope: AiResultScope | null) =>
  value !== null && scope !== null && value.entryId === scope.entryId && value.revision === scope.revision
  && value.language === scope.language && value.epoch === scope.epoch;

async function savedResult(article: AiArticle, task: AiTask, language: AiTargetLanguage, contentHash: string) {
  const record = await getAiResult(aiResultKey(article.id, task, language)).catch(() => null);
  return record?.contentHash === contentHash ? record.text : null;
}

function saveResult(
  config: AiConfig,
  article: AiArticle,
  task: AiTask,
  language: AiTargetLanguage,
  contentHash: string,
  text: string,
  generation: number,
) {
  void putAiResult({
    key: aiResultKey(article.id, task, language),
    entryId: article.id,
    task,
    language,
    contentHash,
    model: config.model,
    text,
    createdAt: new Date().toISOString(),
  }, generation).catch(() => undefined);
}

/** Translates segments, retrying missing ones once; rejects rather than accept a partial reply. */
async function translateSegments(config: AiConfig, segments: string[], language: AiTargetLanguage, signal: AbortSignal) {
  const translated = new Map<number, string>();
  let pending = segments.map((_, index) => index);
  for (let attempt = 0; attempt < 2 && pending.length; attempt += 1) {
    const result = await streamAiCompletion(config, translationPrompt(pending.map((index) => segments[index]), language), { signal });
    const parsed = parseTranslationSegments(result.text);
    if (!parsed.size && pending.length === 1) parsed.set(1, stripCodeFence(result.text).trim());
    pending.forEach((index, position) => {
      const value = parsed.get(position + 1);
      if (value) translated.set(index, value);
    });
    pending = pending.filter((index) => !translated.has(index));
  }
  if (pending.length) throw new AiRequestError("incomplete");
  return translated;
}

/**
 * Summary and translation state for the open article. Results are saved per
 * entry, task, and language, and reused while the article content is
 * unchanged; `force` regenerates and replaces a saved result. Bump
 * `resultsEpoch` after clearing saved results to drop in-memory results.
 */
export function useArticleAi(
  config: AiConfig | null,
  article: AiArticle | null,
  language: AiTargetLanguage,
  resultsEpoch: number,
  onTranslationError: (cause: unknown) => void,
) {
  const [summaryState, setSummaryState] = useState<ArticleSummary | null>(null);
  const [translationState, setTranslationState] = useState<ArticleTranslation | null>(null);
  const summaryRun = useRef<AbortController | null>(null);
  const translationRun = useRef<AbortController | null>(null);
  const articleId = article?.id;
  const title = article?.title;
  const content = article?.content;
  const revision = useMemo(
    () => title === undefined || content === undefined ? "" : aiArticleRevision(title, content),
    [title, content],
  );
  const scope: AiResultScope | null = articleId === undefined ? null : { entryId: articleId, revision, language, epoch: resultsEpoch };

  // Leaving the scope cancels its work and drops its results, so no busy or
  // translated state outlives the article revision, language, or provider.
  useEffect(() => () => {
    summaryRun.current?.abort();
    translationRun.current?.abort();
    setSummaryState(null);
    setTranslationState(null);
  }, [articleId, revision, language, resultsEpoch, config]);

  const summary = sameScope(summaryState, scope) ? summaryState : null;
  const translation = sameScope(translationState, scope) ? translationState : null;

  const runSummary = async (activeConfig: AiConfig, target: AiArticle, runScope: AiResultScope, force: boolean) => {
    summaryRun.current?.abort();
    const controller = new AbortController();
    summaryRun.current = controller;
    const generation = currentAiResultsGeneration();
    const update = (next: Pick<ArticleSummary, "status" | "text" | "error">) => {
      if (!controller.signal.aborted) setSummaryState({ ...runScope, open: true, ...next });
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
      saveResult(activeConfig, target, "summary", language, contentHash, result.text, generation);
    } catch (cause) {
      update({ status: "error", text: "", error: cause });
    }
  };

  const runTranslation = async (activeConfig: AiConfig, target: AiArticle, runScope: AiResultScope, force: boolean) => {
    translationRun.current?.abort();
    const controller = new AbortController();
    translationRun.current = controller;
    const generation = currentAiResultsGeneration();
    const update = (next: Pick<ArticleTranslation, "status" | "html" | "done" | "total">) => {
      if (!controller.signal.aborted) setTranslationState({ ...runScope, showing: true, ...next });
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
        const segments = await translateSegments(
          activeConfig,
          chunk.map((blockIndex) => prepared.blocks[blockIndex].source),
          language,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        chunk.forEach((blockIndex, position) => applyTranslation(prepared.blocks[blockIndex], segments.get(position)!));
        update({ status: "translating", html: serializeTranslation(prepared), done: index + 1, total: chunks.length });
      }
      const html = serializeTranslation(prepared, true);
      update({ status: "done", html, done: chunks.length, total: chunks.length });
      saveResult(activeConfig, target, "translation", language, contentHash, html, generation);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setTranslationState(null);
      onTranslationError(cause);
    }
  };

  const toggleSummary = (force = false) => {
    if (!config || !article || !scope) return;
    if (summary && (summary.status === "loading" || summary.status === "streaming")) {
      summaryRun.current?.abort();
      setSummaryState(null);
      return;
    }
    if (!force && summary?.status === "done") return setSummaryState({ ...summary, open: !summary.open });
    if (!force && summary?.status === "error") return setSummaryState(null);
    void runSummary(config, article, scope, force);
  };

  const toggleTranslation = (force = false) => {
    if (!config || !article || !scope) return;
    if (translation && translation.status !== "done") {
      translationRun.current?.abort();
      setTranslationState(null);
      return;
    }
    if (!force && translation) return setTranslationState({ ...translation, showing: !translation.showing });
    void runTranslation(config, article, scope, force);
  };

  const retrySummary = () => {
    if (config && article && scope) void runSummary(config, article, scope, true);
  };

  return { summary, translation, toggleSummary, toggleTranslation, retrySummary };
}
