// The Markdown a reply is parsed into (src/views/markdown.ts). Only `parse`
// and `spansOf` are exercised: drawing needs a DOM, and a DOM in these tests
// would mean a dependency the repo does without.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, spansOf } from "../src/views/markdown.ts";

const kinds = (spans) => spans.map((s) => `${s.kind}:${s.text}`);

test("a paragraph keeps its inline shapes", () => {
  assert.deepEqual(
    kinds(spansOf("Run **cargo test** in `windows/` first")),
    ["text:Run ", "bold:cargo test", "text: in ", "code:windows/", "text: first"],
  );
});

test("backticks win over everything inside them", () => {
  assert.deepEqual(kinds(spansOf("use `**ptr` carefully")), [
    "text:use ",
    "code:**ptr",
    "text: carefully",
  ]);
});

test("a link keeps its label and where it points", () => {
  const [link] = spansOf("[the docs](https://example.com/a)");
  assert.equal(link.kind, "link");
  assert.equal(link.text, "the docs");
  assert.equal(link.href, "https://example.com/a");
});

test("a link with no label falls back to showing the target", () => {
  assert.equal(spansOf("[](https://example.com)")[0].text, "https://example.com");
});

test("a fenced block is code, language and all, and is never re-parsed", () => {
  const blocks = parse("Before\n\n```rust\nlet x = **not bold**;\n```\n\nAfter");
  assert.deepEqual(blocks.map((b) => b.kind), ["paragraph", "code", "paragraph"]);
  assert.equal(blocks[1].language, "rust");
  assert.equal(blocks[1].text, "let x = **not bold**;");
});

test("a fence the reply was cut off before runs to the end", () => {
  const blocks = parse("```\nhalf a block");
  assert.deepEqual(blocks, [{ kind: "code", language: "", text: "half a block" }]);
});

test("headings carry their level", () => {
  const blocks = parse("# One\n\n### Three");
  assert.deepEqual(blocks.map((b) => [b.kind, b.level]), [
    ["heading", 1],
    ["heading", 3],
  ]);
});

test("a list is one block, and the two kinds do not merge", () => {
  const blocks = parse("- first\n- second\n1. one\n2. two");
  assert.deepEqual(blocks.map((b) => [b.kind, b.ordered, b.items.length]), [
    ["list", false, 2],
    ["list", true, 2],
  ]);
});

test("a wrapped list item stays one item", () => {
  const [list] = parse("- a long item\n  that wrapped\n- another");
  assert.equal(list.items.length, 2);
  assert.deepEqual(kinds(list.items[0]), ["text:a long item that wrapped"]);
});

test("a blank line ends a paragraph and nothing empty is kept", () => {
  assert.deepEqual(parse("\n\n   \n").length, 0);
  assert.deepEqual(parse("one\n\ntwo").map((b) => b.kind), ["paragraph", "paragraph"]);
});

test("plain text comes through untouched", () => {
  const [block] = parse("nothing special here");
  assert.deepEqual(kinds(block.spans), ["text:nothing special here"]);
});
