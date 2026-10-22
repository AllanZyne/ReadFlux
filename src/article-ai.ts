import { useEffect, useMemo, useRef, useState } from "react";
import {
  aiArticleRevision,
  aiContentHash,
  AiRequestError,
  aiResultKey,
  chunkSegments,
  completedTranslationSegments,
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
import { currentAiResultsGeneration, getAiResult, putAiResult, setAiResultVisible } from "./readflux-client";

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
  /** Translated and total blocks (paragraphs, headings, list items). */
  done: number;
  total: number;
  showing: boolean;
};

const sameScope = (value: AiResultScope | null, scope: AiResultScope | null) =>
  value !== null && scope !== null && value.entryId === scope.entryId && value.revision === scope.revision
  && value.language === scope.language && value.epoch === scope.epoch;

async function savedRecord(article: AiArticle, task: AiTask, language: AiTargetLanguage, contentHash: string) {
  const record = await getAiResult(aiResultKey(article.id, task, language)).catch(() => null);
  return record?.contentHash === contentHash ? record : null;
}

async function savedResult(article: AiArticle, task: AiTask, language: AiTargetLanguage, contentHash: string) {
  return (await savedRecord(article, task, language, contentHash))?.text ?? null;
}

/** Remembers whether a saved result is showing, so reopening the article restores it. */
function rememberVisible(entryId: number, task: AiTask, language: AiTargetLanguage, visible: boolean) {
  void setAiResultVisible(aiResultKey(entryId, task, language), visible).catch(() => undefined);
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

/**
 * Translates segments, retrying missing ones once; rejects rather than accept
 * a partial reply. `onSegment` receives each segment as soon as it is complete.
 */
async function translateSegments(
  config: AiConfig,
  segments: string[],
  language: AiTargetLanguage,
  signal: AbortSignal,
  onSegment: (index: number, value: string) => void,
) {
  const translated = new Map<number, string>();
  const accept = (index: number | undefined, value: string | undefined) => {
    if (index === undefined || !value || translated.get(index) === value) return;
    translated.set(index, value);
    onSegment(index, value);
  };
  let pending = segments.map((_, index) => index);
  for (let attempt = 0; attempt < 2 && pending.length; attempt += 1) {
    const batch = pending;
    const result = await streamAiCompletion(config, translationPrompt(batch.map((index) => segments[index]), language), {
      signal,
      onText: (text) => completedTranslationSegments(text).forEach((value, marker) => accept(batch[marker - 1], value)),
    });
    const parsed = parseTranslationSegments(result.text);
    if (!parsed.size && batch.length === 1) parsed.set(1, stripCodeFence(result.text).trim());
    batch.forEach((index, position) => accept(index, parsed.get(position + 1)));
    pending = batch.filter((index) => !translated.has(index));
  }
  if (pending.length) throw new AiRequestError("incomplete");
}

/**
 * Summary and translation state for the open article. Results are saved per
 * entry, task, and language, and reused while the article content is
 * unchanged; `force` regenerates and replaces a saved result. A saved result
 * that was showing when the article was last open is shown again on reopen.
 * Bump `resultsEpoch` after clearing saved results to drop in-memory results.
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

  // Saved results that were showing when the article was last open are shown
  // again. This reads IndexedDB only; nothing is sent to the provider.
  useEffect(() => {
    if (!config || articleId === undefined || title === undefined || content === undefined) return;
    const restoreScope: AiResultScope = { entryId: articleId, revision, language, epoch: resultsEpoch };
    const target: AiArticle = { id: articleId, title, content };
    let cancelled = false;
    void (async () => {
      const contentHash = await aiContentHash(`${title}\n${content}`);
      const [savedSummary, savedTranslation] = await Promise.all([
        savedRecord(target, "summary", language, contentHash),
        savedRecord(target, "translation", language, contentHash),
      ]);
      if (cancelled) return;
      const keep = <T extends AiResultScope>(current: T | null) => current !== null && sameScope(current, restoreScope);
      if (savedSummary && savedSummary.visible !== false) {
        setSummaryState((current) => keep(current) ? current : { ...restoreScope, status: "done", text: savedSummary.text, open: true });
      }
      if (savedTranslation && savedTranslation.visible !== false) {
        setTranslationState((current) => keep(current) ? current : { ...restoreScope, status: "done", html: savedTranslation.text, done: 1, total: 1, showing: true });
      }
    })().catch(() => undefined);
    return () => { cancelled = true; };
  // `revision` already tracks the title and content.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
      if (saved !== null) {
        rememberVisible(target.id, "summary", language, true);
        return update({ status: "done", text: saved });
      }
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
      if (saved !== null) {
        rememberVisible(target.id, "translation", language, true);
        return update({ status: "done", html: saved, done: 1, total: 1 });
      }
      const prepared = prepareTranslation(target.content);
      if (!prepared.blocks.length) throw new AiRequestError("empty");
      const total = prepared.blocks.length;
      const translatedBlocks = new Set<number>();
      update({ status: "translating", html: serializeTranslation(prepared), done: 0, total });
      for (const chunk of chunkSegments(prepared.blocks.map((block) => block.source))) {
        await translateSegments(
          activeConfig,
          chunk.map((blockIndex) => prepared.blocks[blockIndex].source),
          language,
          controller.signal,
          (position, value) => {
            if (controller.signal.aborted) return;
            applyTranslation(prepared.blocks[chunk[position]], value);
            translatedBlocks.add(chunk[position]);
            update({ status: "translating", html: serializeTranslation(prepared), done: translatedBlocks.size, total });
          },
        );
        if (controller.signal.aborted) return;
      }
      const html = serializeTranslation(prepared, true);
      update({ status: "done", html, done: total, total });
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
    if (!force && summary?.status === "done") {
      rememberVisible(summary.entryId, "summary", summary.language, !summary.open);
      return setSummaryState({ ...summary, open: !summary.open });
    }
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
    if (!force && translation) {
      rememberVisible(translation.entryId, "translation", translation.language, !translation.showing);
      return setTranslationState({ ...translation, showing: !translation.showing });
    }
    void runTranslation(config, article, scope, force);
  };

  const retrySummary = () => {
    if (config && article && scope) void runSummary(config, article, scope, true);
  };

  return { summary, translation, toggleSummary, toggleTranslation, retrySummary };
}
