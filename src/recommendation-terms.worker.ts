import initializeJieba, { tag, type Tag } from "wasmjieba-web";

type WorkerRequest =
  | { id: number; type: "initialize" }
  | { id: number; type: "extract"; title: string; summary: string };

type WorkerResponse =
  | { id: number; ok: true; titleTags?: Tag[]; summaryTags?: Tag[] }
  | { id: number; ok: false; message: string };

let initialization: Promise<void> | null = null;

function ensureInitialized() {
  if (!initialization) {
    initialization = initializeJieba().then(() => {
      // Force dictionary decompression and construction outside the article-open path.
      tag("中文分词预热", true);
    });
  }
  return initialization;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  void ensureInitialized().then(() => {
    const response: WorkerResponse = request.type === "initialize"
      ? { id: request.id, ok: true }
      : {
          id: request.id,
          ok: true,
          titleTags: tag(request.title, true),
          summaryTags: tag(request.summary, true),
        };
    self.postMessage(response);
  }).catch((cause) => {
    const response: WorkerResponse = {
      id: request.id,
      ok: false,
      message: cause instanceof Error ? cause.message : "Jieba initialization failed",
    };
    self.postMessage(response);
  });
};
