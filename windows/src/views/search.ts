// Finding things in the conversation.
//
// Split in two on purpose: `findMatches` is a pure function over the message
// model and is tested without a DOM, and `highlight` is the DOM pass that runs
// after Markdown has been drawn. Searching the rendered output instead would
// mean searching the markup — a query for `code` would hit every `<code>` tag
// — and searching before rendering would lose the positions.
//
// What this can reach is the island's own log, which is the last forty
// messages (see transcript.rs). It is not the CLI's full history, and the
// counter says so by counting what is there.

import type { ChatMessage } from "../core/state";

/** Where one hit is: which message, and where in its text. */
export interface Match {
  /** `ChatMessage.id`. */
  id: number;
  /** Index into the message's content. */
  at: number;
  length: number;
}

/** The shortest query worth running. One letter matches everything. */
export const MIN_QUERY = 2;

/**
 * Every hit, in reading order — oldest message first, and within a message
 * left to right. Case-insensitive, because nobody searching a transcript
 * means to be particular about it.
 */
export function findMatches(messages: ChatMessage[], query: string): Match[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < MIN_QUERY) return [];

  const out: Match[] = [];
  for (const message of messages) {
    const hay = message.content.toLowerCase();
    let at = hay.indexOf(needle);
    while (at !== -1) {
      out.push({ id: message.id, at, length: needle.length });
      at = hay.indexOf(needle, at + needle.length);
    }
  }
  return out;
}

/** "3/12", or "none" when there is nothing — never "0/0". */
export function counter(matches: Match[], index: number): string {
  if (matches.length === 0) return "none";
  return `${index + 1}/${matches.length}`;
}

/**
 * Steps through the hits, wrapping at both ends.
 *
 * Wrapping rather than stopping is what people expect of a find bar, and it
 * means the two buttons never need disabling.
 */
export function step(matches: Match[], index: number, by: number): number {
  if (matches.length === 0) return 0;
  return (index + by + matches.length) % matches.length;
}

/**
 * Wraps every occurrence of `query` inside `root` in a `<mark>`, and returns
 * the marks in document order.
 *
 * Works on text nodes, so it reaches inside code blocks and bold runs without
 * disturbing them — and cannot break the markup, because no markup is parsed:
 * a text node is split and one piece is wrapped.
 */
export function highlight(root: HTMLElement, query: string): HTMLElement[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < MIN_QUERY) return [];

  // Collected first: splitting text nodes while walking them would have the
  // walker visit the halves it just created.
  const texts: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue && node.nodeValue.toLowerCase().includes(needle)) {
      texts.push(node as Text);
    }
  }

  const marks: HTMLElement[] = [];
  for (const text of texts) {
    let node = text;
    for (;;) {
      const value = node.nodeValue ?? "";
      const at = value.toLowerCase().indexOf(needle);
      if (at === -1) break;

      // splitText leaves `node` as the part before the hit and returns the
      // rest; splitting that again isolates exactly the hit.
      const hit = node.splitText(at);
      const rest = hit.splitText(needle.length);
      const mark = document.createElement("mark");
      mark.className = "hit";
      mark.textContent = hit.nodeValue;
      hit.replaceWith(mark);
      marks.push(mark);
      node = rest;
    }
  }
  return marks;
}
