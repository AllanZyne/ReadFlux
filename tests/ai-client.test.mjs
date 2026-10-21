import assert from "node:assert/strict";
import test from "node:test";

const ai = await import("../src/ai-client.ts");
const client = await import("../src/readflux-client.ts");

const openai = { provider: "openai", baseURL: "https://api.openai.com/v1/", apiKey: "sk-test", model: "gpt-4.1-mini" };
const anthropic = { provider: "anthropic", baseURL: "https://api.anthropic.com", apiKey: "sk-ant-test", model: "claude-opus-5-5" };
const prompt = { system: "System text", user: "User text" };

const streamOf = (...chunks) => new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder();
    chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
    controller.close();
  },
});

async function withFetch(response, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("OpenAI-compatible requests stream chat completions and send the key only when present", () => {
  const { url, init } = ai.buildAiRequest(openai, prompt);
  assert.equal(url, "https://api.openai.com/v1/chat/completions");
  assert.equal(init.headers.Authorization, "Bearer sk-test");
  assert.deepEqual(JSON.parse(init.body), {
    model: "gpt-4.1-mini",
    stream: true,
    messages: [{ role: "system", content: "System text" }, { role: "user", content: "User text" }],
  });

  const local = ai.buildAiRequest({ ...openai, baseURL: "http://localhost:11434/v1", apiKey: " " }, prompt);
  assert.equal(local.url, "http://localhost:11434/v1/chat/completions");
  assert.equal("Authorization" in local.init.headers, false);
});

test("Anthropic requests call the Messages API directly from the browser", () => {
  const { url, init } = ai.buildAiRequest({ ...anthropic, baseURL: "https://api.anthropic.com/v1/" }, prompt);
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(init.headers["x-api-key"], "sk-ant-test");
  assert.equal(init.headers["anthropic-version"], "2023-06-01");
  assert.equal(init.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(init.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.system, "System text");
  assert.deepEqual(body.messages, [{ role: "user", content: "User text" }]);
  assert.equal(body.stream, true);
  assert.equal(body.fallbacks, "default");
  assert.deepEqual(body.output_config, { effort: "low" });
});

test("Anthropic options are limited to models that accept them", () => {
  const haiku = JSON.parse(ai.buildAiRequest({ ...anthropic, model: "claude-haiku-5-5" }, prompt).init.body);
  assert.equal("fallbacks" in haiku, false);
  assert.deepEqual(haiku.output_config, { effort: "low" });
  const older = ai.buildAiRequest({ ...anthropic, model: "claude-haiku-4-5" }, prompt);
  const olderBody = JSON.parse(older.init.body);
  assert.equal("output_config" in olderBody, false);
  assert.equal("fallbacks" in olderBody, false);
  assert.equal("anthropic-beta" in older.init.headers, false);
});

test("server-sent events are parsed across chunk boundaries and line endings", async () => {
  const events = [];
  for await (const event of ai.readServerSentEvents(streamOf(
    "event: content_block_delta\r\ndata: {\"a\"",
    ":1}\r\n\r\n: keep-alive\n\ndata: first\ndata: second\n\n",
    "data: [DONE]",
  ))) events.push(event);
  assert.deepEqual(events, [
    { event: "content_block_delta", data: "{\"a\":1}" },
    { data: "first\nsecond" },
    { data: "[DONE]" },
  ]);
});

test("stream chunks expose text, stop reasons, and provider errors", () => {
  assert.deepEqual(ai.aiStreamChunk("anthropic", { data: "{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}" }), { text: "Hi" });
  assert.deepEqual(ai.aiStreamChunk("anthropic", { data: "{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"\"}}" }), {});
  assert.deepEqual(ai.aiStreamChunk("anthropic", { data: "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\"}}" }), { stopReason: "refusal" });
  assert.deepEqual(ai.aiStreamChunk("anthropic", { data: "{\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}" }), { error: "Overloaded" });
  assert.deepEqual(ai.aiStreamChunk("openai", { data: "{\"choices\":[{\"delta\":{\"content\":\"Hi\"},\"finish_reason\":null}]}" }), { text: "Hi" });
  assert.deepEqual(ai.aiStreamChunk("openai", { data: "[DONE]" }), { done: true });
});

test("inline reasoning from OpenAI-compatible models is hidden, even mid-stream", () => {
  assert.equal(ai.visibleCompletionText("<reasoning>They want OK.</reasoning>OK"), "OK");
  assert.equal(ai.visibleCompletionText("<think>\nplan\n</think>\n\n- One"), "- One");
  assert.equal(ai.visibleCompletionText("<reasoning>still thinking"), "");
  assert.equal(ai.visibleCompletionText("- One\n- Two"), "- One\n- Two");
});

test("an OpenAI-compatible stream with inline reasoning completes with only the answer", async () => {
  const chunk = (content, finish = null) => `data: ${JSON.stringify({ choices: [{ delta: content === undefined ? {} : { content }, finish_reason: finish, index: 0 }] })}\n\n`;
  const response = new Response(streamOf(
    chunk("", null),
    chunk("<reasoning>The user wants OK.</reasoning>"),
    chunk(undefined),
    chunk("OK"),
    chunk(undefined, "stop"),
    "data: [DONE]\n\n",
  ), { status: 200 });
  const seen = [];
  const result = await withFetch(response, (calls) => ai.streamAiCompletion(openai, prompt, { onText: (text) => seen.push(text) }).then((value) => {
    assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
    return value;
  }));
  assert.deepEqual(result, { text: "OK", stopReason: "stop" });
  assert.equal(seen.includes("The user wants OK."), false);
  assert.equal(seen.at(-1), "OK");
});

test("failed completions raise typed errors", async () => {
  await withFetch(new Response("{\"error\":{\"message\":\"invalid x-api-key\"}}", { status: 401 }), async () => {
    await assert.rejects(ai.streamAiCompletion(anthropic, prompt), (error) =>
      error instanceof ai.AiRequestError && error.kind === "http" && error.status === 401 && error.detail === "invalid x-api-key");
  });
  await withFetch(new TypeError("Failed to fetch"), async () => {
    await assert.rejects(ai.streamAiCompletion(openai, prompt), (error) => error instanceof ai.AiRequestError && error.kind === "network");
  });
  const refusal = new Response(streamOf(
    "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\"}}\n\n",
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
  ), { status: 200 });
  await withFetch(refusal, async () => {
    await assert.rejects(ai.streamAiCompletion(anthropic, prompt), (error) => error instanceof ai.AiRequestError && error.kind === "refusal");
  });
});

test("model lists are requested from the configured base URL", () => {
  const openaiModels = ai.buildAiModelsRequest(openai);
  assert.equal(openaiModels.url, "https://api.openai.com/v1/models");
  assert.equal(openaiModels.init.headers.Authorization, "Bearer sk-test");
  assert.equal("Authorization" in ai.buildAiModelsRequest({ ...openai, apiKey: "" }).init.headers, false);

  const anthropicModels = ai.buildAiModelsRequest({ ...anthropic, baseURL: "https://api.anthropic.com/v1" });
  assert.equal(anthropicModels.url, "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(anthropicModels.init.headers["x-api-key"], "sk-ant-test");
  assert.equal(anthropicModels.init.headers["anthropic-dangerous-direct-browser-access"], "true");
});

test("model lists are sorted, de-duplicated, and labeled", async () => {
  assert.deepEqual(ai.parseAiModels({ data: [
    { id: "gpt-b" },
    { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
    { id: "gpt-b" },
    { id: "" },
    { name: "missing id" },
  ] }), [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "gpt-b", label: "gpt-b" },
  ]);
  assert.deepEqual(ai.parseAiModels({ models: [] }), []);
  assert.deepEqual(ai.parseAiModels(null), []);

  const listed = await withFetch(new Response(JSON.stringify({ object: "list", data: [{ id: "qwen3:8b" }] }), { status: 200 }),
    () => ai.listAiModels({ ...openai, baseURL: "http://localhost:11434/v1", apiKey: "" }));
  assert.deepEqual(listed, [{ id: "qwen3:8b", label: "qwen3:8b" }]);
  await withFetch(new Response("<UnknownOperationException/>", { status: 404 }), async () => {
    await assert.rejects(ai.listAiModels(openai), (error) => error instanceof ai.AiRequestError && error.status === 404);
  });
});

test("translation segments round-trip through markers, tolerating fences and gaps", () => {
  const formatted = ai.formatTranslationSegments(["Hello <t0>world</t0>", "Second"]);
  assert.equal(formatted, "<<<1>>>\nHello <t0>world</t0>\n\n<<<2>>>\nSecond");
  const parsed = ai.parseTranslationSegments("```\n<<<1>>>\n你好<t0>世界</t0>\n\n<<<3>>>\n第三\n```");
  assert.deepEqual([...parsed], [[1, "你好<t0>世界</t0>"], [3, "第三"]]);
  assert.equal(ai.translationPrompt(["A"], "fr").user, "<<<1>>>\nA");
});

test("segments are grouped into bounded requests in document order", () => {
  assert.deepEqual(ai.chunkSegments(["aaaa", "bb", "cc", "dddddd", "e"], 6), [[0, 1], [2], [3], [4]]);
  assert.deepEqual(ai.chunkSegments([], 6), []);
});

test("placeholder tags are tokenized with their text unescaped", () => {
  assert.deepEqual(ai.tokenizeTaggedText("Read <t0>the &lt;b&gt; guide</t0><x1/> now<x2 />"), [
    { kind: "text", text: "Read " },
    { kind: "open", id: 0 },
    { kind: "text", text: "the <b> guide" },
    { kind: "close", id: 0 },
    { kind: "void", id: 1 },
    { kind: "text", text: " now" },
    { kind: "void", id: 2 },
  ]);
  assert.equal(ai.escapeTaggedText("a < b & c"), "a &lt; b &amp; c");
});

test("summary lines drop list markers and blank lines", () => {
  assert.deepEqual(ai.summaryLines("- First point\n\n• Second\n2. Third\n  Fourth  "), ["First point", "Second", "Third", "Fourth"]);
});

test("saved results are keyed by entry, task, and language and invalidated by content", async () => {
  assert.equal(ai.aiResultKey(42, "summary", "zh-Hans"), "42:summary:zh-Hans");
  const first = await ai.aiContentHash("Title\n<p>Body</p>");
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(await ai.aiContentHash("Title\n<p>Body</p>"), first);
  assert.notEqual(await ai.aiContentHash("Title\n<p>Body updated</p>"), first);
});

test("the default target language follows the interface language", () => {
  assert.equal(ai.aiLanguageForInterface("zh-CN"), "zh-Hans");
  assert.equal(ai.aiLanguageForInterface("zh-TW"), "zh-Hant");
  assert.equal(ai.aiLanguageForInterface("fr"), "fr");
  assert.equal(ai.aiLanguageForInterface("de-DE"), "de");
  assert.equal(ai.aiLanguageForInterface("xx"), "en");
  assert.match(ai.aiLanguagePromptName("zh-Hans"), /Chinese \(zh-Hans\)$/);
});

test("profile settings keep only supported translation languages", () => {
  assert.equal(client.normalizeProfileSettings({ translationLanguage: "ja" }).translationLanguage, "ja");
  assert.equal("translationLanguage" in client.normalizeProfileSettings({ translationLanguage: "klingon" }), false);
  assert.equal("translationLanguage" in client.normalizeProfileSettings({}), false);
});
