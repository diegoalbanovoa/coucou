// Every visible string in src/views, src/settings and src/island goes
// through t()/tn() — see docs/plan-v2.md § 2.4. This greps for the DOM
// helper's text-bearing attributes (`h(tag, { text: "…" })`, `title:`,
// `"aria-label":`) and for direct `.textContent =`/`.title =` assignments,
// the places a literal string actually reaches the screen, and fails on
// anything outside a small, explicit allowlist of proper nouns and
// universal acronyms this plan deliberately never translates (see the
// dictionaries' own header comments in src/i18n/en.ts and es.ts).
//
// Not a general-purpose lint: it does not understand template literals with
// interpolation (`` `${x} of them` `` is invisible to it, by design — those
// are caught by hand, the way every string in this migration already was),
// and a literal that is purely punctuation/digits is not UI copy worth a
// translation key, so it is let through rather than demanding one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const SCOPES = ["views", "settings", "island"].map((d) => join(SRC, d));

function allFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? allFiles(path) : [path];
  });
}

/**
 * Proper nouns, brand names and acronyms this plan's own dictionary leaves
 * untranslated (see docs/plan-v2.md § 2.4 and the i18n files' headers) —
 * exact matches only, so a real sentence that happens to contain one of
 * these words is still caught.
 */
const ALLOWED = new Set([
  "Coucou", "Mochi",
  "Claude Code", "Claude", "Gemini", "Codex", "Copilot", "Cursor", "Qwen", "OpenCode",
  "PowerShell", "Windows Terminal", "VS Code", "Visual Studio Code", "Git Bash", "Cursor Agent",
  "Tabby", "WezTerm", "Alacritty", "Windsurf",
  "n8n", "Vercel", "GitHub", "Stripe", "Resend", "Cal.com", "Notion", "Obsidian",
  "API", "PDF", "URL", "N", "Y",
  "config", "settings.json", "Relay",
]);

/** Only literals with a letter are UI copy — a bare "·", "—" or "{n}/{n}" is
 *  punctuation or a format string, not a sentence needing a translation. */
function isWorthFlagging(literal) {
  return /[A-Za-zÀ-ÿ]/.test(literal) && !ALLOWED.has(literal);
}

const PATTERNS = [
  /\btext:\s*"([^"]*)"/g,
  /\btitle:\s*"([^"]*)"/g,
  /"aria-label":\s*"([^"]*)"/g,
  /\.textContent\s*=\s*"([^"]*)"/g,
  /\.title\s*=\s*"([^"]*)"/g,
];

test("no literal UI string outside src/i18n in views/settings/island", () => {
  const offenders = [];
  for (const scope of SCOPES) {
    for (const file of allFiles(scope)) {
      if (extname(file) !== ".ts") continue;
      const text = readFileSync(file, "utf8");
      const rel = relative(SRC, file).split(sep).join("/");
      for (const pattern of PATTERNS) {
        for (const match of text.matchAll(pattern)) {
          const literal = match[1];
          if (isWorthFlagging(literal)) offenders.push(`${rel}: "${literal}"`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `hardcoded UI strings found:\n${offenders.join("\n")}`);
});
