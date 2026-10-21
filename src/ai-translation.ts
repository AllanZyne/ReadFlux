import { escapeTaggedText, tokenizeTaggedText } from "./ai-client.ts";

/**
 * Block elements are translated one at a time. Inline markup inside a block is
 * sent as numbered placeholders so links, emphasis, and images survive the
 * round trip without exposing attributes such as URLs to the model.
 */
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "CAPTION", "DD", "DETAILS", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER",
  "HGROUP", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY",
  "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);
/** Kept verbatim and never translated. */
const ATOMIC_TAGS = new Set([
  "AUDIO", "BR", "CANVAS", "CODE", "EMBED", "IFRAME", "IMG", "INPUT", "KBD", "MATH", "OBJECT",
  "PICTURE", "SAMP", "SCRIPT", "SOURCE", "STYLE", "SVG", "TEXTAREA", "VIDEO", "WBR",
]);
const SKIPPED_BLOCKS = new Set(["PRE", "SCRIPT", "STYLE", "SVG", "MATH", "TEXTAREA"]);

export const TRANSLATION_PENDING_CLASS = "aiTranslationPending";

export type TranslationBlock = {
  element: Element;
  source: string;
  nodes: Node[];
  atomic: boolean[];
};

export type TranslationDocument = {
  document: Document;
  blocks: TranslationBlock[];
};

const hasWords = (node: Node) => /\p{L}/u.test(node.textContent ?? "");

const BLOCK_SELECTOR = [...BLOCK_TAGS].map((tag) => tag.toLowerCase()).join(",");

function isBlock(node: Node): node is Element {
  return node instanceof Element && BLOCK_TAGS.has(node.tagName);
}

/** An inline element such as `<a>` that wraps a block such as `<h2>`. */
function wrapsBlock(node: Node): node is Element {
  return node instanceof Element && !BLOCK_TAGS.has(node.tagName) && !ATOMIC_TAGS.has(node.tagName)
    && node.querySelector(BLOCK_SELECTOR) !== null;
}

function collectBlocks(container: Element, blocks: Element[]) {
  const children = [...container.childNodes];
  if (!children.some((child) => isBlock(child) || wrapsBlock(child))) {
    if (hasWords(container)) blocks.push(container);
    return;
  }
  let run: Node[] = [];
  const flush = () => {
    if (run.some(hasWords)) {
      const wrapper = container.ownerDocument.createElement("span");
      container.insertBefore(wrapper, run[0]);
      wrapper.append(...run);
      blocks.push(wrapper);
    }
    run = [];
  };
  for (const child of children) {
    if (wrapsBlock(child)) {
      flush();
      collectBlocks(child, blocks);
      continue;
    }
    if (!isBlock(child)) {
      run.push(child);
      continue;
    }
    flush();
    if (!SKIPPED_BLOCKS.has(child.tagName)) collectBlocks(child, blocks);
  }
  flush();
}

function encodeChildren(node: Node, block: Pick<TranslationBlock, "nodes" | "atomic">): string {
  let encoded = "";
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      encoded += escapeTaggedText((child.textContent ?? "").replace(/\s+/g, " "));
      return;
    }
    if (!(child instanceof Element)) return;
    const id = block.nodes.length;
    if (ATOMIC_TAGS.has(child.tagName) || BLOCK_TAGS.has(child.tagName)) {
      block.nodes.push(child.cloneNode(true));
      block.atomic.push(true);
      encoded += `<x${id}/>`;
      return;
    }
    block.nodes.push(child.cloneNode(false));
    block.atomic.push(false);
    encoded += `<t${id}>${encodeChildren(child, block)}</t${id}>`;
  });
  return encoded;
}

export function prepareTranslation(html: string): TranslationDocument {
  const document = new DOMParser().parseFromString(html, "text/html");
  const elements: Element[] = [];
  collectBlocks(document.body, elements);
  const blocks = elements.map((element) => {
    const block: TranslationBlock = { element, source: "", nodes: [], atomic: [] };
    block.source = encodeChildren(element, block).trim();
    element.classList.add(TRANSLATION_PENDING_CLASS);
    return block;
  });
  return { document, blocks };
}

/** Replaces a block's children with translated text, restoring its placeholders. */
export function applyTranslation(block: TranslationBlock, translated: string) {
  const document = block.element.ownerDocument;
  const fragment = document.createDocumentFragment();
  const stack: { id: number; parent: Node }[] = [{ id: -1, parent: fragment }];
  const used = new Set<number>();
  for (const token of tokenizeTaggedText(translated)) {
    const top = stack[stack.length - 1].parent;
    if (token.kind === "text") {
      top.appendChild(document.createTextNode(token.text));
    } else if (token.kind === "open") {
      const original = block.nodes[token.id];
      if (!original || block.atomic[token.id] || used.has(token.id)) continue;
      used.add(token.id);
      const element = original.cloneNode(false);
      top.appendChild(element);
      stack.push({ id: token.id, parent: element });
    } else if (token.kind === "close") {
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].id !== token.id) continue;
        stack.length = depth;
        break;
      }
    } else {
      const original = block.nodes[token.id];
      if (!original || !block.atomic[token.id] || used.has(token.id)) continue;
      used.add(token.id);
      top.appendChild(original.cloneNode(true));
    }
  }
  // Media the model dropped is appended rather than lost.
  block.atomic.forEach((atomic, id) => {
    if (atomic && !used.has(id) && block.nodes[id].nodeName !== "BR") fragment.appendChild(block.nodes[id].cloneNode(true));
  });
  block.element.replaceChildren(fragment);
  block.element.classList.remove(TRANSLATION_PENDING_CLASS);
}

export function serializeTranslation(translation: TranslationDocument, final = false) {
  if (final) {
    translation.blocks.forEach((block) => {
      block.element.classList.remove(TRANSLATION_PENDING_CLASS);
      if (!block.element.classList.length) block.element.removeAttribute("class");
    });
  }
  return translation.document.body.innerHTML;
}

/** Plain article text for summaries, keeping one line per block. */
export function articlePlainText(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");
  document.querySelectorAll("script,style,svg,math,noscript").forEach((node) => node.remove());
  document.body.querySelectorAll("*").forEach((element) => {
    if (element.tagName === "BR") element.after(document.createTextNode("\n"));
    else if (BLOCK_TAGS.has(element.tagName)) {
      element.before(document.createTextNode("\n"));
      element.append(document.createTextNode("\n"));
    }
  });
  return (document.body.textContent ?? "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
