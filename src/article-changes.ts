import { collectTextBlocks } from "./ai-translation.ts";

/**
 * What changed in an updated article since the version the user last read.
 * Only the current text is shown: changed words carry the text they replaced,
 * and removals leave a marker that carries the removed text. Everything is
 * compared locally, block by block and then word by word.
 */

/** A change inside one block, as offsets into its current text. */
export type TextEdit = {
  start: number;
  end: number;
  /** The text this range replaced, empty for an insertion; at an empty range, the text removed there. */
  previous: string;
};

export type BlockChange =
  | { kind: "added"; index: number }
  | { kind: "changed"; index: number; edits: TextEdit[] }
  | { kind: "removed"; before: number; previous: string[] };

export type TextChange = "inserted" | "replaced" | "removed";

export type TextPart = { text: string; change?: TextChange; previous?: string };

export type MarkedArticle = { html: string; count: number };

/** Longer comparisons are skipped rather than freezing the reader. */
const MAX_COMPARED_CELLS = 2_000_000;
/** Blocks this similar are one edited block rather than a removal and an addition. */
const MIN_BLOCK_SIMILARITY = 0.3;
/** Below this share of unchanged text the article was rewritten, and marks would cover it. */
const MIN_KEPT_SHARE = 0.3;
/** Pairing removed with added blocks compares every pair in a gap; past this many, it was rewritten. */
const MAX_BLOCK_COMPARISONS = 50_000;

type Token = { key: string; start: number; end: number; word: boolean };
type Segment = { segment: string; index: number; isWordLike?: boolean };

/** Without `Intl.Segmenter`, each Han character is a word and other words run to a space or punctuation. */
const FALLBACK_SEGMENT = /\s+|\p{Script=Han}|[\p{L}\p{M}\p{N}_]+(?:[.,'’][\p{L}\p{M}\p{N}_]+)*|[^\s]/gu;

let segmenter: Intl.Segmenter | null | undefined;

function segments(text: string): Iterable<Segment> {
  if (segmenter === undefined) {
    segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;
  }
  if (segmenter) return segmenter.segment(text);
  return [...text.matchAll(FALLBACK_SEGMENT)].map((match) => ({
    segment: match[0],
    index: match.index,
    isWordLike: /[\p{L}\p{N}]/u.test(match[0]),
  }));
}

/** Words, punctuation, and runs of white space, which all compare equal. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const { segment, index, isWordLike } of segments(text)) {
    const space = !segment.trim();
    const last = tokens.at(-1);
    if (space && last?.key === " ") {
      last.end = index + segment.length;
      continue;
    }
    tokens.push({ key: space ? " " : segment, start: index, end: index + segment.length, word: Boolean(isWordLike) });
  }
  return tokens;
}

/** Index pairs of a longest common subsequence, or null when the inputs are too long to compare. */
function commonSubsequence(a: readonly string[], b: readonly string[]): [number, number][] | null {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const n = a.length - prefix - suffix;
  const m = b.length - prefix - suffix;
  if (n * m > MAX_COMPARED_CELLS) return null;
  // The subsequence is never longer than the shorter side, at most √MAX_COMPARED_CELLS.
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[prefix + i] === b[prefix + j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  for (let k = 0; k < prefix; k += 1) pairs.push([k, k]);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[prefix + i] === b[prefix + j]) {
      pairs.push([prefix + i, prefix + j]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i += 1;
    else j += 1;
  }
  for (let k = 0; k < suffix; k += 1) pairs.push([a.length - suffix + k, b.length - suffix + k]);
  return pairs;
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

function gapEdit(previous: string, a: Token[], b: Token[], i0: number, i1: number, j0: number, j1: number): TextEdit | null {
  let start = j0;
  let end = j1;
  while (start < end && b[start].key === " ") start += 1;
  while (end > start && b[end - 1].key === " ") end -= 1;
  const removed = i1 > i0 ? collapse(previous.slice(a[i0].start, a[i1 - 1].end)) : "";
  if (start < end) return { start: b[start].start, end: b[end - 1].end, previous: removed };
  if (!removed) return null;
  const at = j0 > 0 ? b[j0 - 1].end : 0;
  return { start: at, end: at, previous: removed };
}

/** Word-level edits that turn `previous` into `current`, or null when they are too long to compare. */
export function diffText(previous: string, current: string): TextEdit[] | null {
  const a = tokenize(previous);
  const b = tokenize(current);
  const pairs = commonSubsequence(a.map((token) => token.key), b.map((token) => token.key));
  if (!pairs) return null;
  // A space kept between two changes joins them, so "120 trains" → "310 buses" is one mark.
  const kept = pairs.filter(([i, j], k) => {
    if (a[i].key !== " ") return true;
    const [pi, pj] = pairs[k - 1] ?? [-1, -1];
    const [ni, nj] = pairs[k + 1] ?? [a.length, b.length];
    return !((i - pi > 1 || j - pj > 1) && (ni - i > 1 || nj - j > 1));
  });
  const edits: TextEdit[] = [];
  let pi = -1;
  let pj = -1;
  for (const [i, j] of [...kept, [a.length, b.length] as const]) {
    if (i - pi > 1 || j - pj > 1) {
      const edit = gapEdit(previous, a, b, pi + 1, i, pj + 1, j);
      if (edit) edits.push(edit);
    }
    pi = i;
    pj = j;
  }
  return edits;
}

const wordSet = (text: string) => new Set(tokenize(text).filter((token) => token.word).map((token) => token.key.toLowerCase()));

function similarity(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  let shared = 0;
  left.forEach((word) => { if (right.has(word)) shared += 1; });
  return shared / Math.max(left.size, right.size, 1);
}

/**
 * Aligns the text blocks of two versions: unchanged blocks are skipped, a
 * similar pair becomes word edits, and the rest are added or removed. Null
 * means the article was rewritten or is too long to compare.
 */
export function diffBlocks(previous: readonly string[], current: readonly string[]): BlockChange[] | null {
  const previousKeys = previous.map(collapse);
  const currentKeys = current.map(collapse);
  const pairs = commonSubsequence(previousKeys, currentKeys);
  if (!pairs) return null;
  // Each block is split into words once, however many blocks it is compared with.
  const previousWords = new Map<number, ReadonlySet<string>>();
  const currentWords = new Map<number, ReadonlySet<string>>();
  const wordsOf = (cache: Map<number, ReadonlySet<string>>, keys: string[], index: number) => {
    let words = cache.get(index);
    if (!words) cache.set(index, words = wordSet(keys[index]));
    return words;
  };
  let comparisons = 0;
  const changes: BlockChange[] = [];
  let changedLength = 0;
  const removed = (before: number, text: string) => {
    const last = changes.at(-1);
    if (last?.kind === "removed" && last.before === before) last.previous.push(text);
    else changes.push({ kind: "removed", before, previous: [text] });
  };
  const added = (index: number) => {
    changes.push({ kind: "added", index });
    changedLength += currentKeys[index].length;
  };
  let pi = -1;
  let pj = -1;
  for (const [i, j] of [...pairs, [previous.length, current.length] as const]) {
    let next = pi + 1;
    // Unpaired removals stay where they were: after the last block paired in this gap.
    let removedBefore = pj + 1;
    // One block replaced by one, as in a table cell of numbers, is an edit whatever its words.
    const oneForOne = i - next === 1 && j - pj - 1 === 1;
    for (let index = pj + 1; index < j; index += 1) {
      let best = oneForOne ? next : -1;
      let bestScore = MIN_BLOCK_SIMILARITY;
      comparisons += i - next;
      if (comparisons > MAX_BLOCK_COMPARISONS) return null;
      for (let k = next; k < i && !oneForOne; k += 1) {
        const score = similarity(wordsOf(previousWords, previousKeys, k), wordsOf(currentWords, currentKeys, index));
        if (score > bestScore) {
          best = k;
          bestScore = score;
        }
      }
      if (best < 0) {
        added(index);
        continue;
      }
      for (; next < best; next += 1) removed(index, previousKeys[next]);
      next = best + 1;
      removedBefore = index + 1;
      const edits = diffText(previous[best], current[index]);
      if (!edits) {
        removed(index, previousKeys[best]);
        added(index);
      } else if (edits.length) {
        changes.push({ kind: "changed", index, edits });
        changedLength += edits.reduce((length, edit) => length + edit.end - edit.start, 0);
      }
    }
    for (; next < i; next += 1) removed(removedBefore, previousKeys[next]);
    pi = i;
    pj = j;
  }
  const total = currentKeys.reduce((length, key) => length + key.length, 0);
  if (!total || changedLength > total * (1 - MIN_KEPT_SHARE)) return null;
  return changes;
}

/** Splits text into unchanged runs and marked changes. */
export function textParts(text: string, edits: readonly TextEdit[]): TextPart[] {
  const parts: TextPart[] = [];
  let at = 0;
  for (const edit of edits) {
    if (edit.start > at) parts.push({ text: text.slice(at, edit.start) });
    if (edit.start === edit.end) parts.push({ text: "", change: "removed", previous: edit.previous });
    else if (edit.previous) parts.push({ text: text.slice(edit.start, edit.end), change: "replaced", previous: edit.previous });
    else parts.push({ text: text.slice(edit.start, edit.end), change: "inserted" });
    at = edit.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** The current title in parts, or null when it did not change. */
export function titleChanges(previous: string, current: string): TextPart[] | null {
  const edits = diffText(previous, current);
  return edits?.length ? textParts(current, edits) : null;
}

function textNodes(block: Element): Text[] {
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest("svg,math,textarea")) nodes.push(node as Text);
  }
  return nodes;
}

/** Marks take focus so the keyboard can reach the card that hover and touch open. */
function changeMark(document: Document, tag: "ins" | "span", className: string, change: string, previous: string) {
  const mark = document.createElement(tag);
  mark.className = className;
  mark.dataset.change = change;
  mark.tabIndex = 0;
  if (previous) mark.dataset.previous = previous;
  return mark;
}

/**
 * Wraps each edit in the block's text nodes. Edits run from last to first, so
 * splitting a node never moves the offsets of the edits still to come.
 */
function markEdits(nodes: Text[], edits: readonly TextEdit[]) {
  const starts: number[] = [];
  let offset = 0;
  nodes.forEach((node) => {
    starts.push(offset);
    offset += node.length;
  });
  for (const edit of [...edits].reverse()) {
    if (edit.start === edit.end) {
      let k = nodes.length - 1;
      while (k > 0 && starts[k] >= edit.start) k -= 1;
      const node = nodes[k];
      const local = edit.start - starts[k];
      const cut = changeMark(node.ownerDocument, "span", "articleChangeCut", "removed", edit.previous);
      if (local <= 0) node.before(cut);
      else {
        if (local < node.length) node.splitText(local);
        node.after(cut);
      }
      continue;
    }
    for (let k = nodes.length - 1; k >= 0; k -= 1) {
      const node = nodes[k];
      const from = Math.max(edit.start - starts[k], 0);
      const to = Math.min(edit.end - starts[k], node.length);
      if (from >= to) continue;
      if (to < node.length) node.splitText(to);
      const piece = from > 0 ? node.splitText(from) : node;
      if (!piece.data.trim()) continue;
      const mark = changeMark(node.ownerDocument, "ins", "articleChange", edit.previous ? "replaced" : "inserted", edit.previous);
      piece.replaceWith(mark);
      mark.append(piece);
    }
  }
}

/** Unlike translation, a block of numbers alone, such as a table cell, can change too. */
const hasComparedText = (node: Node) => /[\p{L}\p{N}]/u.test(node.textContent ?? "");

function parseBlocks(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");
  const wrappers = new Set<Element>();
  const blocks = collectTextBlocks(document.body, [], wrappers, hasComparedText);
  return { document, blocks, wrappers };
}

/**
 * Marks the changes from `previousHtml` in `currentHtml`. Both must already be
 * sanitized; the marks add only elements and data attributes. Null when
 * nothing in the text changed or the article was rewritten.
 */
export function markArticleChanges(currentHtml: string, previousHtml: string): MarkedArticle | null {
  const previous = parseBlocks(previousHtml);
  const current = parseBlocks(currentHtml);
  const currentNodes = current.blocks.map(textNodes);
  const changes = diffBlocks(
    previous.blocks.map((block) => textNodes(block).map((node) => node.data).join("")),
    currentNodes.map((nodes) => nodes.map((node) => node.data).join("")),
  );
  if (!changes?.length) return null;
  let count = 0;
  for (const change of changes) {
    if (change.kind === "changed") {
      markEdits(currentNodes[change.index], change.edits);
      count += change.edits.length;
      continue;
    }
    count += 1;
    if (change.kind === "added") {
      const block = current.blocks[change.index];
      block.classList.add("articleChangeAdded");
      block.setAttribute("data-change", "added-block");
      block.setAttribute("tabindex", "0");
      continue;
    }
    const marker = changeMark(current.document, "span", "articleChangeGone", "removed-block", change.previous.join("\n\n"));
    const next = current.blocks[change.before];
    if (next) next.prepend(marker);
    else current.document.body.append(marker);
  }
  current.wrappers.forEach((wrapper) => {
    if (!wrapper.classList.length) wrapper.replaceWith(...wrapper.childNodes);
  });
  return { html: current.document.body.innerHTML, count };
}
