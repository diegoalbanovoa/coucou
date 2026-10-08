// A small Markdown renderer for agent replies.
//
// Hand-written on purpose: the repo takes no third-party dependency it can
// avoid, and what a CLI reply actually uses is a short list — fenced code,
// inline code, bold, italic, headings, lists and links.
//
// Parsing is separate from drawing so the parsing can be tested without a DOM
// (`parse`), and so the drawing can build nodes rather than HTML text: nothing
// in a reply is ever parsed as markup, whatever the agent wrote.

/** A run of text inside one block. */
export interface Span {
  kind: "text" | "code" | "bold" | "italic" | "link";
  text: string;
  /** Where a link points. Only ever set on `link`. */
  href?: string;
}

export type Block =
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "list"; ordered: boolean; items: Span[][] }
  | { kind: "code"; language: string; text: string };

/**
 * Inline tokens, in the order they are tried. Code comes first: backticks win
 * over everything inside them, which is what makes `**not bold**` safe.
 */
const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]*\]\([^)\s]+\))/;

const FENCE = /^\s*```+\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.+)$/;
const BULLET = /^\s*[-*+]\s+(.+)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.+)$/;

/** The spans of one line of text. */
export function spansOf(text: string): Span[] {
  const out: Span[] = [];
  let rest = text;

  const push = (span: Span) => {
    if (span.text.length > 0) out.push(span);
  };

  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (!match) {
      push({ kind: "text", text: rest });
      break;
    }
    push({ kind: "text", text: rest.slice(0, match.index) });

    const token = match[0];
    if (token.startsWith("`")) {
      push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("**")) {
      push({ kind: "bold", text: token.slice(2, -2) });
    } else if (token.startsWith("*") || token.startsWith("_")) {
      push({ kind: "italic", text: token.slice(1, -1) });
    } else {
      const cut = token.indexOf("](");
      const label = token.slice(1, cut);
      const href = token.slice(cut + 2, -1);
      push({ kind: "link", text: label || href, href });
    }
    rest = rest.slice(match.index + token.length);
  }
  return out;
}

/** The blocks of a whole reply. */
export function parse(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  function flush() {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", spans: spansOf(paragraph.join(" ")) });
      paragraph = [];
    }
    if (list) {
      blocks.push({
        kind: "list",
        ordered: list.ordered,
        items: list.items.map(spansOf),
      });
      list = null;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      // An unclosed fence runs to the end: a reply cut off mid-block is still
      // worth showing as code.
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      blocks.push({ kind: "code", language: fence[1] ?? "", text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        spans: spansOf(heading[2]),
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = numbered != null;
      const item = (bullet ?? numbered)![1];
      // A list of the other kind is a list of its own.
      if (list && list.ordered !== ordered) flush();
      if (paragraph.length > 0) flush();
      list = list ?? { ordered, items: [] };
      list.items.push(item);
      continue;
    }

    // A plain line after a list item continues that item rather than starting
    // a paragraph inside the list.
    if (list) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

function spanNode(span: Span): Node {
  switch (span.kind) {
    case "code": {
      const code = document.createElement("code");
      code.className = "md-code";
      code.textContent = span.text;
      return code;
    }
    case "bold": {
      const b = document.createElement("b");
      b.textContent = span.text;
      return b;
    }
    case "italic": {
      const i = document.createElement("i");
      i.textContent = span.text;
      return i;
    }
    case "link": {
      // Nothing in the island navigates — a click would replace the island
      // with the page — so a link shows its label and names its target.
      const link = document.createElement("span");
      link.className = "md-link";
      link.textContent = span.text;
      link.title = span.href ?? "";
      return link;
    }
    default:
      return document.createTextNode(span.text);
  }
}

function fill(parent: HTMLElement, spans: Span[]): HTMLElement {
  for (const span of spans) parent.append(spanNode(span));
  return parent;
}

/** One reply, as nodes ready to append. */
export function render(text: string): DocumentFragment {
  const out = document.createDocumentFragment();

  for (const block of parse(text)) {
    switch (block.kind) {
      case "heading": {
        const heading = document.createElement("div");
        heading.className = `md-h md-h${Math.min(block.level, 3)}`;
        out.append(fill(heading, block.spans));
        break;
      }
      case "list": {
        const list = document.createElement(block.ordered ? "ol" : "ul");
        list.className = "md-list";
        block.items.forEach((item) => {
          list.append(fill(document.createElement("li"), item));
        });
        out.append(list);
        break;
      }
      case "code": {
        const pre = document.createElement("pre");
        pre.className = "md-pre";
        const code = document.createElement("code");
        code.textContent = block.text;
        pre.append(code);
        if (block.language) pre.dataset.language = block.language;
        out.append(pre);
        break;
      }
      default: {
        const p = document.createElement("p");
        p.className = "md-p";
        out.append(fill(p, block.spans));
      }
    }
  }
  return out;
}
