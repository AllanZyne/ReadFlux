export type AiProvider = "openai" | "anthropic";

export const AI_EFFORTS = ["low", "medium", "high"] as const;
export type AiEffort = typeof AI_EFFORTS[number];

export type AiConfig = {
  provider: AiProvider;
  baseURL: string;
  apiKey: string;
  model: string;
  /** Reasoning effort; the provider's default when unset. */
  effort?: AiEffort;
};

export type AiTask = "summary" | "translation";

export type AiPrompt = {
  system: string;
  user: string;
};

export const AI_PROVIDER_DEFAULTS: Record<AiProvider, { baseURL: string; model: string }> = {
  openai: { baseURL: "https://api.openai.com/v1", model: "" },
  anthropic: { baseURL: "https://api.anthropic.com", model: "claude-opus-5-5" },
};

export const AI_TARGET_LANGUAGES = ["en", "zh-Hans", "zh-Hant", "ja", "ko", "fr", "de", "es", "pt", "it", "ru"] as const;
export type AiTargetLanguage = typeof AI_TARGET_LANGUAGES[number];

/** Characters of encoded segment text sent in one translation request. */
export const TRANSLATION_CHUNK_CHARS = 4000;

const ANTHROPIC_MAX_TOKENS = 16000;

export function isAiProvider(value: unknown): value is AiProvider {
  return value === "openai" || value === "anthropic";
}

export function isAiEffort(value: unknown): value is AiEffort {
  return typeof value === "string" && AI_EFFORTS.includes(value as AiEffort);
}

export function isAiTargetLanguage(value: unknown): value is AiTargetLanguage {
  return typeof value === "string" && AI_TARGET_LANGUAGES.includes(value as AiTargetLanguage);
}

/** Maps an interface locale to the translation target it implies. */
export function aiLanguageForInterface(language?: string): AiTargetLanguage {
  const normalized = language?.toLowerCase() ?? "en";
  if (normalized === "zh-tw" || normalized === "zh-hk" || normalized.startsWith("zh-hant")) return "zh-Hant";
  if (normalized.startsWith("zh")) return "zh-Hans";
  const base = normalized.split("-")[0];
  return AI_TARGET_LANGUAGES.find((candidate) => candidate === base) ?? "en";
}

/** The language name given to the model, e.g. "Simplified Chinese (zh-Hans)". */
export function aiLanguagePromptName(language: AiTargetLanguage) {
  let name: string = language;
  try {
    name = new Intl.DisplayNames(["en"], { type: "language" }).of(language) ?? language;
  } catch { /* fall back to the language tag */ }
  return `${name} (${language})`;
}

export function aiResultKey(entryId: number, task: AiTask, language: AiTargetLanguage) {
  return `${entryId}:${task}:${language}`;
}

export async function aiContentHash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function summaryPrompt(title: string, text: string, language: AiTargetLanguage): AiPrompt {
  const target = aiLanguagePromptName(language);
  return {
    system: [
      "You summarize articles for a feed reader.",
      `Write the summary in ${target}, whatever the article's language.`,
      "Output 3 to 5 bullet points, one per line, each starting with \"- \" and holding one sentence.",
      "Use plain text only: no headings, no Markdown emphasis, and no introduction or closing remarks.",
    ].join(" "),
    user: `Title: ${title}\n\nArticle:\n${text}`,
  };
}

export function translationPrompt(segments: string[], language: AiTargetLanguage): AiPrompt {
  const target = aiLanguagePromptName(language);
  return {
    system: [
      `You translate article segments into ${target} for a feed reader.`,
      "Each segment starts with a marker line such as <<<1>>>.",
      "Return every segment in the same order: its unchanged marker line, then its translation.",
      "Segments contain placeholder tags such as <t3>...</t3> and <x5/>. Keep every placeholder,",
      "placing it around or between the translated words where it belongs; never add, drop, or rename one.",
      "Keep URLs, code, and names that are normally left untranslated.",
      `If a segment is already in ${target}, return it unchanged.`,
      "Output only the markers and translations.",
    ].join(" "),
    user: formatTranslationSegments(segments),
  };
}

export function connectionTestPrompt(): AiPrompt {
  return { system: "Reply with the single word OK.", user: "Connection test." };
}

export function formatTranslationSegments(segments: string[]) {
  return segments.map((segment, index) => `<<<${index + 1}>>>\n${segment}`).join("\n\n");
}

/** Reads `<<<n>>>` marked segments back from a model reply, keyed by marker number. */
export function parseTranslationSegments(output: string) {
  const segments = new Map<number, string>();
  const parts = stripCodeFence(output).split(/^[ \t]*<<<(\d+)>>>[ \t]*$/m);
  for (let index = 1; index < parts.length; index += 2) {
    const value = parts[index + 1]?.trim();
    if (value) segments.set(Number(parts[index]), value);
  }
  return segments;
}

export function stripCodeFence(value: string) {
  const fenced = value.trim().match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1] : value;
}

/**
 * Groups segment indexes into requests of at most `limit` characters. A single
 * segment longer than the limit gets a request of its own.
 */
export function chunkSegments(segments: string[], limit = TRANSLATION_CHUNK_CHARS) {
  const chunks: number[][] = [];
  let current: number[] = [];
  let size = 0;
  segments.forEach((segment, index) => {
    if (current.length && size + segment.length > limit) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(index);
    size += segment.length;
  });
  if (current.length) chunks.push(current);
  return chunks;
}

/** Splits streamed summary text into bullet lines without their list markers. */
export function summaryLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*•·]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}

export type TaggedToken =
  | { kind: "text"; text: string }
  | { kind: "open" | "close" | "void"; id: number };

export function escapeTaggedText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeTaggedText(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Tokenizes translated text that carries `<tN>`, `</tN>`, and `<xN/>` placeholders. */
export function tokenizeTaggedText(value: string): TaggedToken[] {
  const tokens: TaggedToken[] = [];
  const pattern = /<(\/)?t(\d+)\s*>|<x(\d+)\s*\/?>/g;
  let last = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ kind: "text", text: unescapeTaggedText(value.slice(last, index)) });
    if (match[3] !== undefined) tokens.push({ kind: "void", id: Number(match[3]) });
    else tokens.push({ kind: match[1] ? "close" : "open", id: Number(match[2]) });
    last = index + match[0].length;
  }
  if (last < value.length) tokens.push({ kind: "text", text: unescapeTaggedText(value.slice(last)) });
  return tokens;
}

export type AiErrorKind = "network" | "http" | "provider" | "refusal" | "empty";

export class AiRequestError extends Error {
  readonly kind: AiErrorKind;
  readonly status?: number;
  readonly detail?: string;

  constructor(kind: AiErrorKind, status?: number, detail?: string) {
    super(detail ? `AI request failed (${kind}): ${detail}` : `AI request failed (${kind})`);
    this.name = "AiRequestError";
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

function trimBaseURL(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function supportsEffort(model: string) {
  return /^claude-(?:opus|sonnet|haiku|fable|mythos)-5(?:-|$)/.test(model);
}

function supportsServerFallback(model: string) {
  return /^claude-(?:opus-5|opus-5-5|sonnet-5-5|fable-5-1)$/.test(model);
}

export function buildAiRequest(config: AiConfig, prompt: AiPrompt): { url: string; init: RequestInit } {
  const model = config.model.trim();
  if (config.provider === "anthropic") {
    const fallback = supportsServerFallback(model);
    return {
      url: `${trimBaseURL(config.baseURL).replace(/\/v1$/, "")}/v1/messages`,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
          ...(fallback ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
        },
        body: JSON.stringify({
          model,
          max_tokens: ANTHROPIC_MAX_TOKENS,
          system: prompt.system,
          messages: [{ role: "user", content: prompt.user }],
          stream: true,
          ...(config.effort && supportsEffort(model) ? { output_config: { effort: config.effort } } : {}),
          ...(fallback ? { fallbacks: "default" } : {}),
        }),
      },
    };
  }
  return {
    url: `${trimBaseURL(config.baseURL)}/chat/completions`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {}),
      },
      body: JSON.stringify({
        model,
        stream: true,
        ...(config.effort ? { reasoning_effort: config.effort } : {}),
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      }),
    },
  };
}

export type AiModelOption = { id: string; label: string };

export function buildAiModelsRequest(config: AiConfig): { url: string; init: RequestInit } {
  if (config.provider === "anthropic") {
    return {
      url: `${trimBaseURL(config.baseURL).replace(/\/v1$/, "")}/v1/models?limit=1000`,
      init: {
        headers: {
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
      },
    };
  }
  return {
    url: `${trimBaseURL(config.baseURL)}/models`,
    init: { headers: config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {} },
  };
}

/** Reads `{ data: [{ id, display_name? }] }` model lists, sorted and de-duplicated. */
export function parseAiModels(payload: unknown): AiModelOption[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const models = new Map<string, AiModelOption>();
  for (const item of data) {
    const { id, display_name: displayName } = (item ?? {}) as { id?: unknown; display_name?: unknown };
    if (typeof id !== "string" || !id.trim() || models.has(id)) continue;
    models.set(id, { id, label: typeof displayName === "string" && displayName.trim() ? displayName : id });
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function listAiModels(config: AiConfig, signal?: AbortSignal) {
  const { url, init } = buildAiModelsRequest(config);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new AiRequestError("network");
  }
  if (!response.ok) throw new AiRequestError("http", response.status, await responseErrorDetail(response));
  try {
    return parseAiModels(await response.json());
  } catch {
    return [];
  }
}

export type ServerSentEvent = { event?: string; data: string };

export async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];
  const dispatch = () => {
    const message = data.length ? { ...(event ? { event } : {}), data: data.join("\n") } : null;
    event = undefined;
    data = [];
    return message;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = done ? "" : lines.pop() ?? "";
      for (const line of lines) {
        if (!line) {
          const message = dispatch();
          if (message) yield message;
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        else if (line.startsWith("event:")) event = line.slice(6).trim();
      }
      if (done) {
        const message = dispatch();
        if (message) yield message;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export type AiStreamChunk = {
  text?: string;
  stopReason?: string;
  error?: string;
  done?: boolean;
};

type StreamPayload = {
  type?: string;
  error?: { message?: string } | string;
  delta?: { type?: string; text?: string; stop_reason?: string | null };
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
};

function payloadError(payload: StreamPayload) {
  if (!payload.error) return undefined;
  return typeof payload.error === "string" ? payload.error : payload.error.message ?? "error";
}

export function aiStreamChunk(provider: AiProvider, message: ServerSentEvent): AiStreamChunk {
  if (provider === "openai" && message.data.trim() === "[DONE]") return { done: true };
  let payload: StreamPayload;
  try {
    payload = JSON.parse(message.data) as StreamPayload;
  } catch {
    return {};
  }
  const error = payloadError(payload);
  if (error) return { error };
  if (provider === "anthropic") {
    if (payload.type === "content_block_delta" && payload.delta?.type === "text_delta") return { text: payload.delta.text ?? "" };
    if (payload.type === "message_delta" && payload.delta?.stop_reason) return { stopReason: payload.delta.stop_reason };
    if (payload.type === "message_stop") return { done: true };
    return {};
  }
  const choice = payload.choices?.[0];
  return {
    ...(choice?.delta?.content ? { text: choice.delta.content } : {}),
    ...(choice?.finish_reason ? { stopReason: choice.finish_reason } : {}),
  };
}

async function responseErrorDetail(response: Response) {
  try {
    const text = await response.text();
    try {
      return payloadError(JSON.parse(text) as StreamPayload) ?? text.slice(0, 200);
    } catch {
      return text.slice(0, 200) || undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * Removes reasoning that some OpenAI-compatible models (gpt-oss, Qwen,
 * DeepSeek) inline in the reply. An unclosed block hides everything after it,
 * so streamed reasoning never flashes on screen.
 */
export function visibleCompletionText(text: string) {
  return text
    .replace(/<(reasoning|think|thinking)>[\s\S]*?<\/\1>/g, "")
    .replace(/<(?:reasoning|think|thinking)>[\s\S]*$/, "")
    .trimStart();
}

export type AiCompletion = { text: string; stopReason?: string };

/**
 * Streams one completion from the configured provider. `onText` receives the
 * accumulated text after every delta. Aborting rejects with the abort error.
 */
export async function streamAiCompletion(
  config: AiConfig,
  prompt: AiPrompt,
  options: { signal?: AbortSignal; onText?: (text: string) => void } = {},
): Promise<AiCompletion> {
  const { url, init } = buildAiRequest(config, prompt);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: options.signal });
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    throw new AiRequestError("network");
  }
  if (!response.ok) throw new AiRequestError("http", response.status, await responseErrorDetail(response));
  if (!response.body) throw new AiRequestError("empty");
  let raw = "";
  let stopReason: string | undefined;
  for await (const message of readServerSentEvents(response.body)) {
    const chunk = aiStreamChunk(config.provider, message);
    if (chunk.error) throw new AiRequestError("provider", undefined, chunk.error);
    if (chunk.text) {
      raw += chunk.text;
      options.onText?.(visibleCompletionText(raw));
    }
    if (chunk.stopReason) stopReason = chunk.stopReason;
    if (chunk.done) break;
  }
  if (stopReason === "refusal" || stopReason === "content_filter") throw new AiRequestError("refusal");
  const text = visibleCompletionText(raw);
  if (!text.trim()) throw new AiRequestError("empty");
  return { text, stopReason };
}
