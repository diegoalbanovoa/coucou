// Visual QA capture (see plan-v2.md § 0.3).
//
// Starts `vite --mode mock` itself, drives the island through Playwright the
// same way a person would — hover the wake strip's visible pill to expand it,
// click a header tab to switch view — and saves one PNG per combination in
// the plan's table to `shots/`. Not every state in that table exists yet:
// console-detail (Fase 3), chat search/streaming (Fase 4/5), and the Mochi
// gallery (Fase 7, deferred — see docs/plan-v2-notas.md) all have real UI to
// reach only once those land. Until then this script takes the shot of
// whatever the view defaults to and prints a note instead of failing, so
// "sin errores" stays true and the gaps stay visible rather than silent.
//
//   npm run shots
//   npm run shots -- providers      (only shots whose label contains "providers")

import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "shots");
// SHOTS_PORT keeps the capture off the dev server's port (1420) when that one
// is in use; vite is told the same port, so strictPort in the config is moot.
const PORT = process.env.SHOTS_PORT ?? "1420";
const BASE = `http://127.0.0.1:${PORT}`;
/** How long the boot greeting takes to settle into the compact pill. Generous
 *  on purpose: a flaky wait here would make every shot after it flaky too. */
const GREETING_MS = 7000;

// Tab tooltips are real UI strings since Fase 2 (src/i18n/) — they read
// differently per locale, so the selector that clicks a tab has to match
// whichever language this particular shot is being taken in.
const TABS = {
  en: { home: "Overview", chat: "Ask", system: "System" },
  es: { home: "Resumen", chat: "Preguntar", system: "Sistema" },
};

/** One shot: where to go, what to click to get there, and the label used in
 *  the saved filename. `ready` is a known gap, not a bug — see the file note. */
function shot({ view, label, url = "", ready = true, settings = false, steps = null }) {
  return { view, label, url, ready, settings, steps };
}

// Real clicks, same as a person: the provider menu and the profile editor
// are reached through the UI, so no mock-only `?state=` is needed for them.
async function openProviderMenu(page) {
  await page.locator(".chat-meta-item .chat-meta-btn").first().click();
  await page.waitForSelector(".chat-dropdown .chat-menu-row", { timeout: 5000 });
}
async function openNewProfileEditor(page, lang) {
  await openProviderMenu(page);
  // The menu caps its height and scrolls; bring its last row into view first.
  await page.locator(".chat-dropdown", { has: page.locator(".chat-menu-row") }).first().evaluate((m) => { m.scrollTop = m.scrollHeight; });
  await page.locator(".chat-menu-row", { hasText: ADD_PROVIDER[lang] }).click();
  await page.locator(".provider-editor-template").click();
  await page.waitForTimeout(300);
}
const ADD_PROVIDER = { en: "Add a provider", es: "Agregar un proveedor" };

const SHOTS = [
  // ── home ──────────────────────────────────────────────────────────────────
  shot({ view: "home", label: "consoles", url: "?pane=consoles" }),
  shot({ view: "home", label: "services", url: "?pane=services" }),
  shot({ view: "home", label: "console-detail", url: "?pane=consoles&state=console-detail", ready: false }),
  // ── chat ──────────────────────────────────────────────────────────────────
  shot({ view: "chat", label: "populated", url: "" }),
  shot({ view: "chat", label: "empty", url: "?state=empty" }),
  shot({ view: "chat", label: "search", url: "?state=search", ready: false }),
  // drop/attachments: Fase 5 — mock-bridge.ts seeds State.fileDragOver /
  // State.chatAttachments directly for these, since neither a real drag nor
  // a real pick can be simulated here.
  shot({ view: "chat", label: "drop", url: "?state=drop" }),
  shot({ view: "chat", label: "attachments", url: "?state=attachments" }),
  shot({ view: "chat", label: "streaming", url: "?state=streaming", ready: false }),
  // Integración 3: the provider picker (with the detected OpenJarvis section)
  // and the new-profile editor after the OpenJarvis template.
  shot({ view: "chat", label: "providers-menu", url: "?scenario=openjarvis", steps: openProviderMenu }),
  shot({ view: "chat", label: "providers-editor", url: "?scenario=openjarvis", steps: openNewProfileEditor }),
  // ── system ────────────────────────────────────────────────────────────────
  shot({ view: "system", label: "ok", url: "?scenario=ok" }),
  shot({ view: "system", label: "strained", url: "?scenario=strained" }),
  shot({ view: "system", label: "sick", url: "?scenario=sick" }),
  shot({ view: "system", label: "storage", url: "?scenario=strained&state=storage" }),
  // Fase 6: the sheet is seeded straight to its results step (see
  // mock-bridge.ts's `state=cleanup`), since reaching it for real needs a
  // click and a wait for a scan this script does not drive.
  shot({ view: "system", label: "cleanup", url: "?scenario=ok&state=cleanup" }),
  // ── settings (own window, own navigation) ────────────────────────────────
  shot({ view: "settings", label: "general", url: "", settings: true }),
  // Same URL as "general": the settings window is one scrolling page, not
  // separate views per section, and the capture is already `fullPage` — so
  // this and "general" are the same screenshot. Kept as its own named shot
  // anyway, since a future section-specific capture (scrolled to anchor)
  // would want the label already in place.
  shot({ view: "settings", label: "health", url: "", settings: true }),
];

const LANGS = ["en", "es"];
/** `[view]: scales`, from the plan's table — settings only ships at 1×. */
const SCALES = { home: [1, 1.5, 2], chat: [1, 1.5], system: [1, 1.5], settings: [1] };

/**
 * `vite.kill()` alone only signals the immediate child. On Windows that child
 * is `npx`, which has already handed the real work to a grandchild `node
 * vite.js` outside the same process group — so the signal never reaches it,
 * and the dev server (and the port it holds) outlives this script. `taskkill
 * /T` kills the whole tree by pid instead of relying on signal propagation.
 */
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  } else {
    child.kill();
  }
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("vite --mode mock never answered on " + BASE);
}

async function expandIsland(page) {
  await page.waitForTimeout(GREETING_MS);
  await page.locator("#island").click();
  await page.waitForSelector("#header", { timeout: 5000 });
}

async function captureIslandShot(browser, { view, label, url, ready, steps }, lang, scale) {
  const name = `${view}-${label}-${lang}-${scale}x`;
  if (!ready) {
    console.log(`skip  ${name} (no UI for this state yet)`);
    return { name, skipped: true };
  }
  const page = await browser.newPage({ viewport: { width: 760, height: 640 }, deviceScaleFactor: scale });
  try {
    const sep = url.includes("?") ? "&" : "?";
    await page.goto(`${BASE}/${url}${sep}lang=${lang}`);
    await expandIsland(page);
    if (view !== "home") await page.click(`button[title="${TABS[lang][view]}"]`);
    await page.waitForTimeout(500);
    if (steps) await steps(page, lang);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    console.log(`shot  ${name}`);
    return { name, skipped: false };
  } finally {
    await page.close();
  }
}

async function captureSettingsShot(browser, { label, ready }, lang, scale) {
  const name = `settings-${label}-${lang}-${scale}x`;
  if (!ready) {
    console.log(`skip  ${name} (no UI for this state yet)`);
    return { name, skipped: true };
  }
  const page = await browser.newPage({ viewport: { width: 640, height: 900 }, deviceScaleFactor: scale });
  try {
    await page.goto(`${BASE}/settings.html?lang=${lang}`);
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
    console.log(`shot  ${name}`);
    return { name, skipped: false };
  } finally {
    await page.close();
  }
}

async function main() {
  // `npm run shots -- <text>` keeps only shots whose label contains <text>
  // and leaves the rest of shots/ (and its manifest) alone.
  const only = process.argv[2];
  const list = only ? SHOTS.filter((s) => s.label.includes(only)) : SHOTS;
  if (!only) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  console.log("starting vite --mode mock…");
  const vite = spawn("npx", ["vite", "--mode", "mock", "--port", PORT, "--strictPort"], { cwd: ROOT, shell: true, stdio: "pipe" });
  vite.stderr.on("data", (d) => process.stderr.write(d));

  let browser;
  const results = [];
  try {
    await waitForServer();
    browser = await chromium.launch();

    for (const s of list) {
      for (const lang of LANGS) {
        for (const scale of SCALES[s.view]) {
          const r = s.settings
            ? await captureSettingsShot(browser, s, lang, scale)
            : await captureIslandShot(browser, s, lang, scale);
          results.push(r);
        }
      }
    }
  } finally {
    await browser?.close();
    killTree(vite);
  }

  const taken = results.filter((r) => !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  if (!only) writeFileSync(
    join(OUT, "manifest.json"),
    JSON.stringify({ takenAt: new Date().toISOString(), taken, skipped, results }, null, 2),
  );
  console.log(`\n${taken} captured, ${skipped} skipped (no UI yet) — see shots/manifest.json`);
}

await main();
