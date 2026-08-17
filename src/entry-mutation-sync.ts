import {
  claimEntryMutations,
  completeEntryMutations,
  getEntryMutations,
  MinifluxRequestError,
  minifluxFetch,
  retryEntryMutations,
  type ConnectionConfig,
  type StoredEntryMutation,
} from "./readflux-client.ts";

export type EntryMutationPatch = {
  status?: "read" | "unread";
  starred?: boolean;
};

export function entryMutationPatches(mutations: StoredEntryMutation[]) {
  const patches = new Map<number, EntryMutationPatch>();
  [...mutations]
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .forEach((mutation) => {
      const patch = patches.get(mutation.entryId) ?? {};
      if (mutation.field === "status") patch.status = mutation.value;
      else patch.starred = mutation.value;
      patches.set(mutation.entryId, patch);
    });
  return patches;
}

export function protectPendingEntryMutations<T extends { id: number }>(
  entries: T[],
  patches: Map<number, EntryMutationPatch>,
) {
  return entries.map((entry) => ({ ...entry, ...patches.get(entry.id) }));
}

function mutationGroupKey(mutation: StoredEntryMutation) {
  return `${mutation.field}:${String(mutation.value)}`;
}

export function groupEntryMutations(mutations: StoredEntryMutation[]) {
  const groups = new Map<string, StoredEntryMutation[]>();
  mutations.forEach((mutation) => {
    const key = mutationGroupKey(mutation);
    groups.set(key, [...(groups.get(key) ?? []), mutation]);
  });
  return [...groups.values()].flatMap((group) => {
    const chunks: StoredEntryMutation[][] = [];
    for (let index = 0; index < group.length; index += 1_000) chunks.push(group.slice(index, index + 1_000));
    return chunks;
  });
}

async function sendMutationGroup(config: ConnectionConfig, mutations: StoredEntryMutation[]) {
  const mutation = mutations[0];
  try {
    await minifluxFetch(config, "/v1/entries", {
      method: "PUT",
      body: JSON.stringify({
        entry_ids: mutations.map((item) => item.entryId),
        [mutation.field]: mutation.value,
      }),
    });
  } catch (cause) {
    const canUseLegacyStarredAPI = mutation.field === "starred"
      && cause instanceof MinifluxRequestError
      && [400, 422].includes(cause.status);
    if (!canUseLegacyStarredAPI) throw cause;
    for (const item of mutations) {
      const remote = await minifluxFetch<{ starred: boolean }>(config, `/v1/entries/${item.entryId}`);
      if (remote.starred !== item.value) {
        await minifluxFetch(config, `/v1/entries/${item.entryId}/bookmark`, { method: "PUT" });
      }
    }
  }
}

async function flushClaimedMutations(config: ConnectionConfig) {
  const claimed = await claimEntryMutations(config);
  let firstError: unknown;
  for (const group of groupEntryMutations(claimed)) {
    try {
      await sendMutationGroup(config, group);
      await completeEntryMutations(config, group);
    } catch (cause) {
      await retryEntryMutations(config, group);
      firstError ??= cause;
    }
  }
  if (firstError) throw firstError;
  return claimed.length;
}

let flushQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>) {
  const result = flushQueue.then(work, work);
  flushQueue = result.catch(() => undefined);
  return result;
}

export function flushEntryMutationOutbox(config: ConnectionConfig) {
  return serialize(async () => {
    const work = () => flushClaimedMutations(config);
    if (navigator.locks) return navigator.locks.request("readflux-miniflux-entry-mutations", work);
    return work();
  });
}

export async function loadEntryMutationPatches(config: ConnectionConfig) {
  return entryMutationPatches(await getEntryMutations(config));
}
