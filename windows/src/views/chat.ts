// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift.
//
// `buildPrompt` creates the whole chat: message log with search, streamed
// draft, composer with `/` palette, attachment tray, provider/project/more
// menus and the provider-profile editor. Turns run through the island's agent
// layer (island/agent.ts); the island registers drops through `takeChatFiles`.

import { h, clear, copyToClipboard } from "./dom";
import { icon, type IconName } from "./icons";
import { render } from "./markdown";
import { counter, findMatches, highlight, step, type Match } from "./search";
import {
  Bridge,
  onEvent,
  providerKeyFor,
  type AgentTurn,
  type ChatAttachment,
  type DroppedFile,
  type ProviderProfile,
} from "../core/bridge";
import { providerHistory } from "../core/provider-history";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import {
  availableClis,
  availableProviders,
  chooseProvider,
  chooseProviderProfile,
  detachProject,
  keepConversation,
  matchingCommands,
  ollamaModels,
  openjarvis,
  pickProject,
  providerLabel,
  reloadProviders,
  startFreshConversation,
} from "../island/agent";
import { orderConsoles } from "../consoles/order";
import { consoleColor } from "../consoles/palette";
import { stillMiniBot, createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { inlineConfirm } from "../ui/inline-confirm";
import { sheet } from "../ui/sheet";
import { button } from "../ui/button";
import type { ViewHost } from "./views";
import { t, tn, getLocale } from "../i18n/index";

/** Ollama's own OpenAI-compatible endpoint — matches `OLLAMA_PROBE`'s host
 *  in providers.rs, but the `/v1` chat path rather than `/api/tags`. */
const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
/** OpenJarvis (`jarvis serve`) default endpoint — verified in docs/plan-v4-notas.md, Fase 1. */
const OPENJARVIS_BASE_URL = "http://127.0.0.1:8000/v1";

/** Maps providers.rs's stable `"<kind>:<detail>"` error string (see
 *  `ProviderError::message`) to the locale's own text. An agent-CLI error
 *  is never in this shape, so it falls through unchanged — this only ever
 *  narrows what a provider-profile turn's error looks like, never widens
 *  what a CLI turn's does. */
function providerErrorMessage(raw: string): string {
  const sep = raw.indexOf(":");
  if (sep < 0) return raw;
  const kind = raw.slice(0, sep);
  const detail = raw.slice(sep + 1);
  switch (kind) {
    case "invalid-key":
      return t("chat.providerErrorInvalidKey");
    case "no-network":
      return t("chat.providerErrorNoNetwork");
    case "rate-limited":
      return t("chat.providerErrorRateLimited");
    case "endpoint":
      return detail;
    default:
      return raw;
  }
}

/**
 * The next message id. Counted off what is already in the log rather than from
 * a module counter: the log may have been restored from disk, and 1 is taken.
 */
function freshId(): number {
  return State.chatHistory.reduce((top, message) => Math.max(top, message.id), 0) + 1;
}

/** How much reply fits before it is folded down. Measured in characters
 * because the island's width is fixed and its height is what we are saving. */
const CLIP_AT = 1400;

/** Local `hh:mm` of a message timestamp, used as its hover title. */
function clockOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * What the agent did during a turn, folded into one line.
 *
 * While the turn runs the line is the step in flight, which is the thing worth
 * watching; once it is over the line is the count, and the list is there for
 * anyone who wants it.
 */
function stepsRow(steps: string[], live: boolean): HTMLElement | null {
  if (steps.length === 0) return null;
  const head = h("button", { class: "steps-head" });
  const list = h("div", { class: "steps-list" });
  for (const step of steps) list.append(h("div", { class: "step", text: step }));

  let open = false;
  const draw = () => {
    head.textContent = open
      ? `${tn("chat.steps", steps.length)} · ${t("chat.hideSteps")}`
      : live
        ? steps[steps.length - 1]
        : tn("chat.steps", steps.length);
    head.classList.toggle("live", live && !open);
    list.classList.toggle("open", open);
  };
  head.addEventListener("click", () => {
    open = !open;
    draw();
  });
  draw();
  return h("div", { class: "steps" }, head, list);
}

/** Copy — the one thing worth doing to a reply that is already on screen —
 *  and, with memory on and a provider profile chatting, "Remember". */
function replyActions(content: string): HTMLElement {
  const copy = h("button", { class: "msg-btn", title: t("chat.copyReply") }, icon("copy", { size: 10 }));
  copy.addEventListener("click", () => {
    void copyToClipboard(content).then((done) => {
      clear(copy);
      copy.append(icon(done ? "check" : "bang", { size: 10 }));
      copy.title = done ? t("chat.copied") : t("chat.copyFailed");
      window.setTimeout(() => {
        clear(copy);
        copy.append(icon("copy", { size: 10 }));
        copy.title = t("chat.copyReply");
      }, 1400);
    });
  });
  const actions = h("div", { class: "msg-actions" }, copy);
  if (State.settings.memoryEnabled && State.selectedProvider) {
    const remember = h("button", { class: "msg-btn", title: t("chat.remember") }, icon("star", { size: 10 }));
    remember.addEventListener("click", () => {
      void Bridge.memoryAdd(content).then(
        () => {
          clear(remember);
          remember.append(icon("check", { size: 10 }));
          remember.title = t("chat.remembered");
        },
        () => {
          clear(remember);
          remember.append(icon("bang", { size: 10 }));
          remember.title = t("chat.rememberFailed");
        },
      );
    });
    actions.append(remember);
  }
  return actions;
}

/** The reply text, folded down when it is long enough to bury the question. */
function replyBody(content: string): HTMLElement {
  const body = h("div", { class: "reply" });
  body.append(render(content));
  if (content.length <= CLIP_AT) return body;

  body.classList.add("clipped");
  const more = h("button", { class: "more-btn", text: t("chat.showWhole") });
  more.addEventListener("click", () => {
    const folded = body.classList.toggle("clipped");
    more.textContent = folded ? t("chat.showWhole") : t("chat.foldBack");
  });
  return h("div", { class: "reply-wrap" }, body, more);
}

/**
 * One message, as a row. `precedingUserText` is the user message right
 * before this one, if there is one — the only thing a failed turn's "Retry"
 * needs, since nothing else about the original prompt survives once it has
 * been sent (see submit()).
 */
/** What a sent message's attachments look like above its bubble — 48px
 *  (plan-v2.md § 5.6), smaller than the tray's own 56px tiles but the same
 *  shape: a thumbnail for images, a glyph and extension for everything else.
 *  A grey, un-clickable tile stands in once the inbox file is gone. */
function sentAttachments(attachments: ChatAttachment[]): HTMLElement {
  const row = h("div", { class: "sent-attach-row" });
  for (const a of attachments) {
    const thumb = h("span", { class: "attach-thumb" });
    if (a.kind === "image") {
      void Bridge.imagePreview(a.id)
        .then((url) => thumb.append(h("img", { src: url, alt: "" })))
        .catch(() => thumb.append(icon("image", { size: 16 }), h("span", { class: "attach-ext", text: extensionOf(a.name) })));
    } else {
      thumb.append(icon(KIND_ICON[a.kind], { size: 16 }), h("span", { class: "attach-ext", text: extensionOf(a.name) }));
    }
    row.append(h("div", { class: "sent-attach-tile", title: a.name }, thumb));
  }
  return row;
}

/**
 * Builds one message row: user bubble (with attachments), error card (with
 * Retry when there is a prompt to resend) or assistant reply (steps, Markdown
 * body and actions). `precedingUserText` and `onRetry` are described in the
 * comment above `sentAttachments`.
 */
function bubble(message: ChatMessage, precedingUserText: string | null, onRetry: (query: string) => void): HTMLElement {
  if (message.role === "user") {
    const column = h("div", { class: "user-col" });
    if (message.attachments && message.attachments.length > 0) column.append(sentAttachments(message.attachments));
    if (message.content.trim() !== "") {
      column.append(h("div", { class: "bubble", text: message.content, title: clockOf(message.at) }));
    }
    return h("div", { class: "chat-row user" }, column);
  }

  if (message.role === "error") {
    const head = h("div", { class: "reply-error-head" }, icon("bang", { size: 10 }), h("span", { text: t("chat.turnStopped") }));
    if (precedingUserText) {
      const retry = h("button", { class: "reply-error-retry", text: t("chat.retry") });
      retry.addEventListener("click", () => onRetry(precedingUserText));
      head.append(retry);
    }
    const card = h(
      "div",
      { class: "reply-error", title: clockOf(message.at) },
      head,
      h("div", { class: "reply-error-detail", text: message.content }),
    );
    const row = h("div", { class: "chat-row" });
    const steps = stepsRow(message.steps ?? [], false);
    if (steps) row.append(h("div", { class: "reply-col" }, steps, card));
    else row.append(card);
    return row;
  }

  const column = h("div", { class: "reply-col", title: clockOf(message.at) });
  const steps = stepsRow(message.steps ?? [], false);
  if (steps) column.append(steps);
  if (message.content.trim() === "") {
    column.append(h("div", { class: "reply quiet", text: t("chat.noReply") }));
  } else {
    column.append(replyBody(message.content), replyActions(message.content));
  }
  return h("div", { class: "chat-row" }, column);
}

/** The reply being written: the steps so far, the text so far, or the dots. */
function draftRow(): HTMLElement {
  const column = h("div", { class: "reply-col" });
  const steps = stepsRow(State.chatSteps, true);
  if (steps) column.append(steps);
  if (State.chatDraft === "") {
    column.append(h("div", { class: "typing" }, h("i"), h("i"), h("i")));
  } else {
    const body = h("div", { class: "reply writing" });
    body.append(render(State.chatDraft));
    column.append(body);
  }
  return h("div", { class: "chat-row" }, column);
}

/**
 * The chat's way in for dropped files, set when the view is built.
 *
 * The island owns the drop event — Tauri delivers it to the window, not to an
 * element — so it has to be able to hand the paths to whichever view wants
 * them. One function rather than an event, because there is exactly one chat.
 * Every drop goes here now (plan-v2.md § 5.2): the island opens the chat
 * before calling this, so there is always somewhere to put the files.
 */
let intoChat: ((paths: string[]) => void) | null = null;

/** Called by the island when a file (of any kind — see attach()) is dropped. */
export function takeChatFiles(paths: string[]) {
  intoChat?.(paths);
}

/** How many attachments may ride on one message, of any kind (plan-v2.md
 *  § 5.4's table), and how large each may be. Mirrored, not shared, from
 *  src-tauri/src/files.rs's own note on why: Rust only learns a drop's size
 *  after copying it, so the cap lives here, checked against what `ingest`
 *  already reports. */
/** Per-message attachment count cap. */
const MAX_ATTACHMENTS = 10;
/** Per-file size cap for any attachment kind (20 MiB). */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Tighter cap for the paste/file-picker path specifically, which can only
 *  ever carry an image (Bridge.pasteImage → files.rs's ingest_bytes, which
 *  hard-refuses anything over this) — mirrors files.rs's own MAX_IMAGE_BYTES. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Extension sets that decide an attachment's kind (see `kindOf`). */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "c", "cpp", "h", "hpp",
  "cs", "rb", "php", "swift", "kt", "sh", "ps1", "sql", "html", "css", "scss", "json", "yaml",
  "yml", "toml", "xml", "vue", "svelte",
]);
const DOC_EXTS = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "md", "txt"]);

/** Which tray glyph a file gets, and whether it gets a thumbnail instead —
 *  decided once by extension and stored on the message that sends it
 *  (ChatAttachment.kind), not re-derived each render. */
function kindOf(name: string): ChatAttachment["kind"] {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (CODE_EXTS.has(ext)) return "code";
  if (DOC_EXTS.has(ext)) return "doc";
  return "other";
}

/** File extension without the dot, or "" when the name has none. */
function extensionOf(name: string): string {
  const ext = name.split(".").pop();
  return ext && ext !== name ? ext : "";
}

/** Glyph per non-image attachment kind. */
const KIND_ICON: Record<Exclude<ChatAttachment["kind"], "image">, IconName> = {
  pdf: "pdf",
  code: "code",
  doc: "doc",
  other: "doc",
};

/**
 * One attachment tile in the tray — 56×56 (plan-v2.md § 5.5). Images get a
 * thumbnail; everything else gets a glyph and its extension. The thumbnail
 * is asked for by path and arrives as a data URI, because the webview never
 * holds file bytes: Tauri intercepts the drop and hands over paths only, so
 * `URL.createObjectURL` has nothing to work with here.
 */
function attachmentTile(file: DroppedFile, onRemove: () => void): HTMLElement {
  const kind = kindOf(file.name);
  const thumb = h("span", { class: "attach-thumb" });
  if (kind === "image") {
    void Bridge.imagePreview(file.path)
      .then((url) => thumb.append(h("img", { src: url, alt: "" })))
      .catch(() => {
        // Too large to inline, or not one of the image kinds Coucou shows
        // inline (see files.rs's IMAGE_EXTS) — the glyph stands in for it,
        // same as any other kind's tile.
        thumb.append(icon("image", { size: 18 }), h("span", { class: "attach-ext", text: extensionOf(file.name) }));
      });
  } else {
    thumb.append(icon(KIND_ICON[kind], { size: 18 }), h("span", { class: "attach-ext", text: extensionOf(file.name) }));
  }

  const remove = h("button", { class: "attach-remove", title: t("files.remove", { name: file.name }) });
  remove.append(icon("xmark", { size: 9 }));
  remove.addEventListener("click", onRemove);

  const tile = h(
    "div",
    { class: "attach-tile", tabindex: 0, title: file.name, "aria-label": t("files.remove", { name: file.name }) },
    thumb,
    remove,
  );
  tile.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Delete" || (e as KeyboardEvent).key === "Backspace") {
      e.preventDefault();
      onRemove();
    }
  });
  return tile;
}

/** Final segment of a Windows or POSIX path (the folder or file name). */
function lastPathComponent(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Dashed rounded rect drawn as SVG so the dashes can march like on macOS —
 *  the drop overlay's border (plan-v2.md § 5.2). */
function dashedFrame(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(ns, "svg");
  el.setAttribute("class", "drop-frame");
  el.setAttribute("preserveAspectRatio", "none");
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("x", "0.75");
  rect.setAttribute("y", "0.75");
  rect.setAttribute("width", "calc(100% - 1.5px)");
  rect.setAttribute("height", "calc(100% - 1.5px)");
  rect.setAttribute("rx", "16");
  rect.setAttribute("fill", "none");
  rect.setAttribute("stroke-width", "1.5");
  rect.setAttribute("stroke-dasharray", "6 5");
  el.append(rect);
  return el;
}

/**
 * The placeholder is the only thing telling the user why a message might not
 * do what they expect, so it names the one blocker rather than a generic hint.
 */
function placeholder(): string {
  // A provider profile has no tools and needs no attached project — the
  // "attach a project first" blocker only applies to an agent CLI turn.
  if (State.selectedProvider) {
    return State.chatHistory.length > 0 ? t("chat.placeholderContinue") : t("chat.placeholderAsk");
  }
  if (!State.agentCli) return t("chat.placeholderNoCli");
  if (!State.attachedProject) return t("chat.placeholderNoProject");
  if (State.chatHistory.length > 0) return t("chat.placeholderContinue");
  return t("chat.placeholderAsk");
}

/**
 * Builds the chat view. `onHeightChange` asks the island to re-measure and
 * resize whenever the content height may have changed (messages, tray, find
 * bar, palette). `sync()` is incremental: history, draft, tray and avatar are
 * each re-rendered only when their own key changes.
 */
export function buildPrompt(onHeightChange: () => void): ViewHost {
  const shotRow = h("div", { class: "shot-row" });
  const log = h("div", { class: "chat-log" });
  // Rebuilt on their own schedules: the history only when a message lands, the
  // draft on every frame a token arrives in.
  const historyBox = h("div", { class: "chat-stack" });
  const draftBox = h("div", { class: "chat-stack" });
  const emptyAvatarSlot = h("span", { class: "chat-empty-avatar" });
  const emptyState = h(
    "div",
    { class: "chat-empty-state" },
    emptyAvatarSlot,
    h("div", { class: "chat-empty-title", text: t("chat.emptyTitle") }),
  );
  log.append(historyBox, draftBox, emptyState);
  const jump = h("button", { class: "jump-btn", title: t("chat.jumpToLatest") }, icon("arrowDown", { size: 10 }));
  const input = h("textarea", {
    class: "chat-input",
    rows: "1",
    spellcheck: "false",
  }) as HTMLTextAreaElement;
  const attachBtn = h("button", { class: "chat-icon-btn chat-attach-btn", title: t("chat.attachImage") }, icon("paperclip", { size: 13 }));
  const fileInput = h("input", {
    type: "file",
    accept: "image/*",
    multiple: "",
    style: "display:none",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: t("chat.send") }, icon("arrowUp", { size: 11 }));
  const bar = h("div", { class: "chat-bar" }, attachBtn, fileInput, input, send);

  // The header carries the three things that decide what a message does:
  // Mochi (which agent, and whether it is thinking), which agent runs it as
  // text, and where. All three read as plain text/a quiet face until
  // hovered, so an ordinary question is not surrounded by machinery.
  const avatarSlot = h("span", { class: "chat-avatar" });
  const providerItem = h("div", { class: "chat-meta-item" });
  const provider = h("button", { class: "chat-meta-btn", title: t("chat.switchConsole") });
  const providerMenu = h("div", { class: "chat-dropdown" });
  providerItem.append(provider, providerMenu);

  const projectItem = h("div", { class: "chat-meta-item" });
  const projectBtn = h("button", { class: "chat-meta-btn" });
  const projectMenu = h("div", { class: "chat-dropdown" });
  projectItem.append(projectBtn, projectMenu);

  const findBtn = h("button", { class: "chat-icon-btn", title: t("chat.findTitle") });
  findBtn.append(icon("search", { size: 11 }));

  const moreItem = h("div", { class: "chat-meta-item" });
  const moreBtn = h("button", { class: "chat-icon-btn", title: t("chat.more") });
  moreBtn.append(icon("ellipsis", { size: 13 }));
  const moreMenu = h("div", { class: "chat-dropdown chat-dropdown-right" });
  moreItem.append(moreBtn, moreMenu);

  const header = h(
    "div",
    { class: "chat-meta" },
    avatarSlot,
    providerItem,
    h("span", { class: "grow" }),
    projectItem,
    findBtn,
    moreItem,
  );

  // ── Dropdown menus (provider / project / more) ───────────────────────────
  //
  // One open at a time: opening a second closes whatever the first left open,
  // and a click anywhere outside the open one's own item closes it too.
  let activeMenu: { item: HTMLElement; popover: HTMLElement } | null = null;

  /** Closes and empties the open dropdown, if any. */
  function closeActiveMenu() {
    if (!activeMenu) return;
    activeMenu.popover.classList.remove("open");
    clear(activeMenu.popover);
    activeMenu = null;
  }

  /** Opens `popover` under `item`, or closes it if it was the open one. */
  function toggleMenu(item: HTMLElement, popover: HTMLElement, fill: () => void) {
    const wasThisOne = activeMenu?.item === item;
    closeActiveMenu();
    if (wasThisOne) return;
    clear(popover);
    fill();
    popover.classList.add("open");
    activeMenu = { item, popover };
    // Same reflex as ui/inline-confirm.ts's own opening focus: a keyboard
    // user who opened this did not do it to stare at the trigger button.
    popover.querySelector<HTMLElement>(".chat-menu-row")?.focus();
  }

  // ── The find bar ────────────────────────────────────────────────────────
  //
  // What it can reach is the island's own log — the last forty messages kept
  // in chat.json — and not the CLI's full history. The counter counts what is
  // there, which is the honest way to say so.
  const findInput = h("input", {
    type: "text",
    class: "find-input",
    placeholder: t("chat.findPlaceholder"),
    spellcheck: "false",
  }) as HTMLInputElement;
  const findCount = h("span", { class: "find-count" });
  const prevBtn = h("button", { class: "chat-icon-btn", title: t("chat.findPrev") });
  prevBtn.append(icon("arrowUp", { size: 10 }));
  const nextBtn = h("button", { class: "chat-icon-btn", title: t("chat.findNext") });
  nextBtn.append(icon("arrowDown", { size: 10 }));
  const closeFind = h("button", { class: "chat-icon-btn", title: t("chat.findClose") });
  closeFind.append(icon("xmark", { size: 10 }));
  const findBar = h(
    "div",
    { class: "find-bar" },
    findInput,
    findCount,
    prevBtn,
    nextBtn,
    closeFind,
  );

  // `/` autocomplete. Hidden unless the input starts with a slash.
  const palette = h("div", { class: "slash-palette" });

  // The drop invitation (plan-v2.md § 5.2) — dashed glass over the message
  // area, not the whole card, so the header and composer stay reachable
  // while something is being dragged in.
  const dropAvatar = h("span", { class: "drop-avatar" });
  const dropTags = h("div", { class: "drop-tags" });
  for (const key of ["pdf", "images", "code", "docs"] as const) {
    dropTags.append(h("span", { text: t(`files.kind.${key}`) }));
  }
  const dropOverlay = h(
    "div",
    { class: "drop-overlay" },
    dashedFrame(),
    h("div", { class: "drop-body" }, dropAvatar, h("div", { class: "drop-title", text: t("files.dropTitle") }), dropTags),
  );
  // A sibling of `log`, not a child of it: `log` scrolls (overflow-y: auto),
  // and an absolutely positioned descendant of a scrolled container moves
  // with that scroll — with a long conversation stuck to its latest message,
  // the overlay landed hundreds of px above the visible viewport. `logWrap`
  // is the one that actually scrolls nowhere, so it is what `.drop-overlay`
  // (style.css) positions itself against.
  // `jump` rides along too (not a sibling in `.chat-body`): it is positioned
  // against the nearest `position: relative` ancestor, which used to be
  // `.card` — fine when nothing sat below the log, but with the attachment
  // tray now also in `.chat-body`, anchoring to the whole card let the
  // button's fixed `bottom` land inside the tray instead of just above it.
  // `logWrap` is the box that actually shrinks to leave the tray room, so
  // anchoring here keeps the button above the log in both cases.
  const logWrap = h("div", { class: "log-wrap" }, log, dropOverlay, jump);

  // Named so the provider-profile editor sheet (openspec/changes/
  // provider-chat-profiles) has somewhere to mount — same role as
  // system.ts's `content` for its own cleanup sheet.
  const chatCard = h(
    "div",
    { class: "card wash chat-card" },
    h(
      "div",
      { class: "chat-body" },
      header,
      findBar,
      logWrap,
      palette,
      shotRow,
      bar,
    ),
  );
  const el = h("div", { class: "view" }, chatCard);
  chatCard.style.setProperty("--wash", "rgba(99,102,241,0.5)");

  el.addEventListener(
    "mousedown",
    (e) => {
      if (activeMenu && !activeMenu.item.contains(e.target as Node)) closeActiveMenu();
    },
    true,
  );

  // Escape closes whichever of the three dropdowns is open, before anything
  // else's own Escape handling (the composer's stop-turn/close-search, the
  // island's own close-on-Escape) gets a turn at the same keypress.
  el.addEventListener(
    "keydown",
    (e) => {
      if (activeMenu && (e as KeyboardEvent).key === "Escape") {
        const trigger = activeMenu.item.querySelector<HTMLElement>("button");
        closeActiveMenu();
        trigger?.focus();
        e.stopPropagation();
      }
    },
    true,
  );

  /** True while an agent/provider turn is in flight. */
  let sending = false;
  // Render sentinels: each region of the view is redrawn only when its key
  // differs; setting one to -1 / "" forces a redraw on the next sync().
  let renderedCount = -1;
  let renderedDraft = "";
  let renderedShots = "";
  let renderedAvatar = "";
  let shownLocale = getLocale();
  let paletteKey = "";
  /** Index of the highlighted `/` command in the palette. */
  let highlighted = 0;
  /** Whether new text should scroll into view — false once the user reads back. */
  let stick = true;
  /** Every hit for the current query, and which one is current. */
  let matches: Match[] = [];
  let current = 0;
  /** Marks placed by the last highlight pass, in document order. */
  let marks: HTMLElement[] = [];
  /** What `↑` on an empty composer recalls — the last message this view
   *  itself sent, not the log's last user turn (which could be a retry, or
   *  from before the view was last rebuilt). */
  let lastSentMessage = "";

  /** Grows the composer 1 to 6 lines with what is typed; `.chat-input`'s own
   *  `max-height` (style.css) is what actually caps it at six — this only
   *  ever asks for `scrollHeight`, never clamps it itself. */
  function autoGrow() {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }

  /** Shows or hides the find bar; closing clears the query and refocuses the composer. */
  function openFind(open: boolean) {
    State.chatQuery = open ? (State.chatQuery ?? "") : null;
    findBar.classList.toggle("open", open);
    if (open) {
      findInput.focus();
      findInput.select();
    } else {
      findInput.value = "";
      runFind("");
      input.focus();
    }
    onHeightChange();
  }

  /** Re-runs the search and repaints the marks. */
  function runFind(query: string) {
    State.chatQuery = State.chatQuery === null ? null : query;
    matches = findMatches(State.chatHistory, query);
    current = 0;
    findCount.textContent = query.trim() ? counter(matches, current) : "";
    // The marks live in the rendered log, which is rebuilt from scratch on
    // every repaint — so the pass runs after, from `sync`, not here.
    renderedCount = -1;
    State.notify();
  }

  /** Moves the current hit by `by` (wrapping), scrolls it into view and stops auto-follow. */
  function goToMatch(by: number) {
    if (marks.length === 0) return;
    current = step(matches, current, by);
    findCount.textContent = counter(matches, current);
    marks.forEach((mark, i) => mark.classList.toggle("on", i === current));
    marks[Math.min(current, marks.length - 1)]?.scrollIntoView({ block: "center" });
    stick = false;
  }

  findBtn.addEventListener("click", () => openFind(State.chatQuery === null));
  closeFind.addEventListener("click", () => openFind(false));
  prevBtn.addEventListener("click", () => goToMatch(-1));
  nextBtn.addEventListener("click", () => goToMatch(1));
  /** Debounce handle so typing does not re-search on every keystroke (120 ms). */
  let findDebounce: number | undefined;
  findInput.addEventListener("input", () => {
    window.clearTimeout(findDebounce);
    const query = findInput.value;
    findDebounce = window.setTimeout(() => runFind(query), 120);
  });
  findInput.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    event.stopPropagation();
    if (key === "Escape") openFind(false);
    else if (key === "Enter") goToMatch((event as KeyboardEvent).shiftKey ? -1 : 1);
  });

  log.addEventListener("scroll", () => {
    stick = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    jump.classList.toggle("on", !stick);
  });
  jump.addEventListener("click", () => {
    stick = true;
    log.scrollTop = log.scrollHeight;
    jump.classList.remove("on");
  });

  // One repaint per frame however fast the tokens arrive: a reply streams in
  // faster than the island can usefully be redrawn.
  let painting = false;
  /** Schedules a single state notification and height update on the next frame. */
  function paint() {
    if (painting) return;
    painting = true;
    requestAnimationFrame(() => {
      painting = false;
      State.notify();
      onHeightChange();
    });
  }

  /**
   * Takes files into the tray, refusing what cannot ride along and saying why.
   *
   * Every file goes through `ingest_file` first, which copies it into the
   * inbox without ever overwriting — so the original is untouched and the
   * copy survives the folder it came from going away mid-conversation. The
   * extension block is Rust's (files.rs's BLOCKED_EXTS, checked before the
   * copy); the count and size caps are this file's own, mirrored from
   * files.rs's own note on why they live here and not there.
   */
  async function attach(paths: string[]) {
    for (const path of paths) {
      if (State.chatAttachments.length >= MAX_ATTACHMENTS) {
        State.noteMessage = tn("files.tooMany", MAX_ATTACHMENTS, { max: MAX_ATTACHMENTS });
        break;
      }
      try {
        const file = await Bridge.ingestFile(path);
        if (file.size > MAX_ATTACHMENT_BYTES) {
          State.noteMessage = t("files.tooLarge", { name: file.name, max: "20 MB" });
          continue;
        }
        State.chatAttachments.push(file);
      } catch (err) {
        const message = String(err).replace(/^Error:\s*/, "");
        State.noteMessage = message === "blocked-extension" ? t("files.blocked", { name: lastPathComponent(path) }) : message;
      }
    }
    renderedShots = "";
    State.notify();
    onHeightChange();
  }

  /**
   * The chat's own drop target. These are the browser's own drag events, not
   * Tauri's — real paths come from the island's native drag-drop pipe
   * instead (island.ts's onDragDrop → takeChatFiles → intoChat, below), so
   * this half only ever drives the invitation's own show/hide; it never
   * tries to read a file from the browser event itself.
   */
  const dropZone = el;
  for (const kind of ["dragenter", "dragover"]) {
    dropZone.addEventListener(kind, (event) => {
      event.preventDefault();
      dropZone.classList.add("dropping");
    });
  }
  for (const kind of ["dragleave", "drop"]) {
    dropZone.addEventListener(kind, () => dropZone.classList.remove("dropping"));
  }

  /** Ingests one in-memory image — from a paste or the paperclip's file
   *  picker, neither of which hands over a path the way a drop does, only
   *  bytes. Same `paste_image` command either way. */
  async function ingestBlob(blob: Blob) {
    const buffer = await blob.arrayBuffer();
    try {
      const file = await Bridge.pasteImage(blob.type, [...new Uint8Array(buffer)]);
      State.chatAttachments.push(file);
      renderedShots = "";
      State.notify();
      onHeightChange();
    } catch (err) {
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.notify();
    }
  }

  /** Pasting is one way an image arrives with no path to copy from; the
   *  paperclip's file picker (below) is the other. */
  input.addEventListener("paste", (event) => {
    const items = (event as ClipboardEvent).clipboardData?.items ?? [];
    for (const item of items) {
      if (!item.type.startsWith("image/")) continue;
      const blob = item.getAsFile();
      if (!blob) continue;
      event.preventDefault();
      void ingestBlob(blob);
      return;
    }
  });

  // Registered for takeChatFiles: the island hands dropped paths here.
  intoChat = (paths) => {
    dropZone.classList.remove("dropping");
    // The short swallow (plan-v2.md § 5.2, ≤600ms, skipped under
    // prefers-reduced-motion by the animation's own CSS) — on the same
    // avatar the header already shows, not a separate character.
    avatarSlot.classList.add("gulp");
    window.setTimeout(() => avatarSlot.classList.remove("gulp"), 600);
    void attach(paths);
  };

  // Streamed turn pieces from Rust: text extends the draft, anything else is a step label.
  void onEvent<AgentTurn>("agent-turn", (turn) => {
    if (turn.kind === "text") State.chatDraft += turn.text;
    else State.chatSteps.push(turn.label);
    paint();
  });

  /** One row of any of the three dropdowns. */
  function menuRow(label: string, onClick: () => void, face?: HTMLElement): HTMLElement {
    const row = h("button", { class: "chat-menu-row" }, ...(face ? [face] : []), h("span", { text: label }));
    row.addEventListener("click", () => {
      closeActiveMenu();
      onClick();
    });
    return row;
  }

  // ── Provider-profile editor (openspec/changes/provider-chat-profiles) ───
  //
  // One sheet, mounted on `chatCard` the same way system.ts mounts its own
  // cleanup sheet. Clicking a saved profile's row opens this (not an
  // immediate switch) — "Use" inside it both saves and selects, so there is
  // one click target per row instead of a trailing edit button nested
  // inside a clickable row (invalid HTML, and two click handlers fighting
  // over the same click).
  let providerEditorEl: HTMLElement | null = null;

  /** Removes the provider editor sheet, if open. */
  function closeProviderEditor() {
    providerEditorEl?.remove();
    providerEditorEl = null;
  }

  /**
   * Opens the add/edit sheet for a provider profile (none = new). Saving also
   * stores the key in the secret store (blank keeps the current one), reloads
   * the profiles and selects it; Delete drops the profile and the selection.
   */
  function openProviderEditor(profile?: ProviderProfile) {
    closeProviderEditor();
    const labelInput = h("input", { type: "text", value: profile?.label ?? "" }) as HTMLInputElement;
    const urlInput = h("input", {
      type: "text",
      placeholder: "https://…",
      value: profile?.baseUrl ?? "",
    }) as HTMLInputElement;
    const modelInput = h("input", { type: "text", value: profile?.model ?? "" }) as HTMLInputElement;
    const keyInput = h("input", {
      type: "password",
      placeholder: profile?.keySet ? t("chat.providerKeyPlaceholder") : "",
    }) as HTMLInputElement;

    const keyHint = h("span", { class: "provider-editor-hint", text: t("chat.openjarvisKeyHint") });
    const usageHint = h("span", { class: "provider-editor-hint", text: t("chat.openjarvisUsageHint") });
    const syncHints = () => {
      const isJarvis = urlInput.value.trim() === OPENJARVIS_BASE_URL;
      keyHint.hidden = !isJarvis;
      usageHint.hidden = !isJarvis;
    };
    urlInput.addEventListener("input", syncHints);
    syncHints();

    const field = (labelText: string, el: HTMLElement) =>
      h("label", { class: "provider-editor-field" }, h("span", { text: labelText }), el);

    const body = h(
      "div",
      { class: "provider-editor-fields" },
      field(t("chat.providerLabelField"), labelInput),
      field(t("chat.providerUrlField"), urlInput),
      field(t("chat.providerModelField"), modelInput),
      field(t("chat.providerKeyField"), keyInput),
      keyHint,
      usageHint,
      profile
        ? null
        : button({
            label: t("chat.openjarvisTemplate"),
            size: "sm",
            onClick: () => {
              urlInput.value = OPENJARVIS_BASE_URL;
              syncHints();
            },
          }),
    );

    /** Persists the profile and its key, then selects it. */
    async function save() {
      const saved = await Bridge.providerSave({
        id: profile?.id,
        label: labelInput.value.trim(),
        baseUrl: urlInput.value.trim(),
        model: modelInput.value.trim(),
      });
      if (!saved) return;
      // Written through the same generic secret commands the 9 fixed keys
      // already use — there is no provider-specific key command. Blank
      // means "keep the current key", not "clear it".
      if (keyInput.value) await Bridge.secretSet(providerKeyFor(saved.id), keyInput.value);
      await reloadProviders();
      chooseProviderProfile(saved.id);
      closeProviderEditor();
      input.focus();
    }

    /** Deletes the profile being edited. */
    async function remove() {
      if (!profile) return;
      await Bridge.providerDelete(profile.id);
      if (State.selectedProvider === profile.id) chooseProviderProfile(null);
      await reloadProviders();
      closeProviderEditor();
      input.focus();
    }

    const footer = h(
      "div",
      { class: "provider-editor-footer" },
      profile ? button({ label: t("chat.deleteProvider"), variant: "destructive", onClick: () => void remove() }) : null,
      h("span", { class: "grow" }),
      button({ label: t("chat.save"), variant: "primary", onClick: () => void save() }),
    );

    providerEditorEl = sheet({
      title: profile ? t("chat.editProvider") : t("chat.addProvider"),
      body,
      footer,
      onClose: () => {
        closeProviderEditor();
        input.focus();
      },
    });
    chatCard.append(providerEditorEl);
  }

  /** An auto-detected Ollama model has nothing to configure (no key, a
   *  fixed local URL) — picking one creates its backing profile silently
   *  the first time, then just selects it from then on. */
  async function selectOllamaModel(modelName: string) {
    const existing = availableProviders.find((p) => p.baseUrl === OLLAMA_BASE_URL && p.model === modelName);
    const profile =
      existing ?? (await Bridge.providerSave({ label: modelName, baseUrl: OLLAMA_BASE_URL, model: modelName }));
    if (!profile) return;
    if (!existing) await reloadProviders();
    chooseProviderProfile(profile.id);
    input.focus();
  }

  /** A detected OpenJarvis model becomes a profile the first time it is picked. */
  async function selectOpenJarvisModel(model: string) {
    const existing = availableProviders.find((p) => p.baseUrl === OPENJARVIS_BASE_URL && p.model === model);
    const profile =
      existing ??
      (await Bridge.providerSave({ label: `OpenJarvis · ${model}`, baseUrl: OPENJARVIS_BASE_URL, model }));
    if (!profile) return;
    if (!existing) await reloadProviders();
    chooseProviderProfile(profile.id);
    input.focus();
  }

  provider.addEventListener("click", () => {
    void (async () => {
      await reloadProviders();
      // Nothing to switch to — opening an empty popover would be worse than
      // the click doing nothing, same as nextProvider() used to no-op here.
      if (availableClis.length === 0 && availableProviders.length === 0 && ollamaModels.length === 0 && !openjarvis) return;
      toggleMenu(providerItem, providerMenu, () => {
        // Same order as the Fase 3 console grid, so picking an agent here and
        // picking one there never disagree about which comes first.
        const ordered = orderConsoles(availableClis, State.agentCli, new Set());
        for (const c of ordered) {
          providerMenu.append(
            menuRow(
              c.label,
              () => {
                chooseProvider(c.id);
                input.focus();
              },
              stillMiniBot(consoleColor(c.id), 14),
            ),
          );
        }
        const globeFace = () => h("span", { class: "chat-menu-face" }, icon("globe", { size: 14 }));
        for (const p of availableProviders) {
          providerMenu.append(menuRow(p.label, () => openProviderEditor(p), globeFace()));
        }
        for (const m of ollamaModels) {
          // Already-saved Ollama models (picked before) show up in the loop
          // above instead, as an ordinary profile — not listed twice here.
          if (availableProviders.some((p) => p.baseUrl === OLLAMA_BASE_URL && p.model === m.name)) continue;
          providerMenu.append(menuRow(m.name, () => void selectOllamaModel(m.name), globeFace()));
        }
        for (const model of openjarvis?.models ?? []) {
          if (availableProviders.some((p) => p.baseUrl === OPENJARVIS_BASE_URL && p.model === model)) continue;
          providerMenu.append(
            menuRow(t("chat.openjarvisModel", { model }), () => void selectOpenJarvisModel(model), globeFace()),
          );
        }
        providerMenu.append(
          menuRow(t("chat.addProvider"), () => openProviderEditor(), h("span", { class: "chat-menu-face" }, icon("plus", { size: 14 }))),
        );
      });
    })();
  });

  projectBtn.addEventListener("click", () => {
    if (!State.attachedProject) {
      void pickProject().then(() => input.focus());
      return;
    }
    toggleMenu(projectItem, projectMenu, () => {
      projectMenu.append(
        menuRow(t("chat.changeProject"), () => void pickProject().then(() => input.focus())),
        menuRow(t("chat.removeProject"), () => void detachProject().then(() => input.focus())),
      );
    });
  });

  moreBtn.addEventListener("click", () => {
    toggleMenu(moreItem, moreMenu, () => {
      const hasHistory = State.chatHistory.length > 0;
      const newChatRow = menuRow(t("chat.newChat"), () => {
        if (!hasHistory) {
          startNewChat();
          return;
        }
        // Replaces the menu in place with the same yes/no pattern every other
        // destructive choice in the island uses (ui/inline-confirm.ts) —
        // never a native confirm(), which rule 5 of docs/plan-v2.md § 1 bans.
        clear(moreMenu);
        moreMenu.append(
          inlineConfirm({
            message: t("chat.newChatConfirm"),
            confirmLabel: t("chat.newChat"),
            cancelLabel: t("common.cancel"),
            destructive: true,
            onConfirm: () => {
              closeActiveMenu();
              startNewChat();
            },
            onCancel: closeActiveMenu,
          }),
        );
      });
      moreMenu.append(newChatRow);
      moreMenu.append(
        menuRow(t("chat.copyConversation"), () => {
          void copyToClipboard(conversationAsText());
        }),
      );
      if (State.attachedProject) {
        const project = State.attachedProject;
        moreMenu.append(menuRow(t("chat.openProjectInVSCode"), () => void Bridge.openInVSCode(project)));
      }
      moreMenu.append(
        menuRow(State.chatExpanded ? t("chat.shrink") : t("chat.grow"), () => {
          State.chatExpanded = !State.chatExpanded;
          State.notify();
          onHeightChange();
        }),
      );
    });
  });

  /** The commands `/` currently offers, or none when not typing a slash. */
  function currentMatches() {
    return matchingCommands(input.value.trim());
  }

  /** Replaces the input with the highlighted command; false if there is none. */
  function applyHighlighted() {
    const matches = currentMatches();
    const chosen = matches[highlighted];
    if (!chosen) return false;
    input.value = `/${chosen.name} `;
    syncPalette();
    return true;
  }

  /** Redraws the `/` palette only when its matches or highlight changed. */
  function syncPalette() {
    const matches = currentMatches();
    const key = `${matches.map((m) => m.name).join(",")}|${highlighted}`;
    if (key === paletteKey) return;
    paletteKey = key;
    clear(palette);
    palette.classList.toggle("open", matches.length > 0);
    matches.forEach((command, i) => {
      const row = h(
        "div",
        { class: i === highlighted ? "slash-row on" : "slash-row" },
        h("span", { class: "slash-name", text: `/${command.name}` }),
        h("span", { class: "slash-desc", text: command.description }),
      );
      // mousedown, not click: the input must not lose focus first.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        highlighted = i;
        applyHighlighted();
        input.focus();
      });
      palette.append(row);
    });
    onHeightChange();
  }

  /** "New chat" from the header's "More" menu. `startFreshConversation`
   *  (agent.ts) is the same drop-the-log-and-chat_forget the island's own
   *  file-drop sequence uses — this adds `agent_reset` on top, which that
   *  sequence deliberately does not: a dropped file still continues whatever
   *  CLI session was running, where this is meant to actually start a new
   *  one (plan v2 § 4.3's "Nuevo chat"). */
  function startNewChat() {
    void Bridge.agentReset();
    startFreshConversation();
    lastSentMessage = "";
    renderedCount = -1;
    onHeightChange();
    input.focus();
  }

  /** "Copy the conversation" — plain text, not Markdown source: a paste
   *  target outside the app (an email, a doc) wants to read it, not render
   *  it. */
  function conversationAsText(): string {
    const who = (role: ChatMessage["role"]) =>
      role === "user" ? t("chat.you") : role === "error" ? t("chat.turnStopped") : providerLabel();
    return State.chatHistory.map((m) => `${who(m.role)}: ${m.content}`).join("\n\n");
  }

  /** `forcedQuery` is "Retry" resending a failed turn's prompt — everything
   *  else about submitting is the same either way. */
  async function submit(forcedQuery?: string) {
    const query = forcedQuery ?? input.value.trim();
    // A caption is not required — "here, look at this" is a whole message
    // when something is already in the tray (plan-v2.md § 5.2: dropped files
    // wait in the tray, never send themselves; this is what lets a user
    // actually send them once they are ready to).
    if ((!query && State.chatAttachments.length === 0) || sending) return;
    if (forcedQuery == null) {
      input.value = "";
      autoGrow();
    }
    lastSentMessage = query;
    highlighted = 0;
    syncPalette();
    sending = true;
    State.chatSending = true;
    Sound.play("send");

    // The agent is told where things are rather than handed their bytes: it
    // can open a file itself, which is the whole point of running the real
    // CLI — attachments go by path, in a fixed header-plus-list shape
    // (plan-v2.md § 5.6) whatever the mix of kinds.
    const attached = State.chatAttachments.slice();
    State.chatAttachments = [];
    renderedShots = "";
    const attachments: ChatAttachment[] = attached.map((f) => ({
      id: f.path,
      name: f.name,
      kind: kindOf(f.name),
      size: f.size,
    }));

    State.chatHistory.push({
      id: freshId(),
      role: "user",
      content: query,
      at: Date.now(),
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    State.chatDraft = "";
    State.chatSteps = [];
    stick = true;
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    const parts = query ? [query] : [];
    if (attached.length > 0) {
      parts.push(`${t("files.promptHeader")}\n${attached.map((f) => `- ${f.path}`).join("\n")}`);
    }
    const prompt = parts.join("\n\n");

    try {
      // The CLI runs the real agent — its own tools, skills and CLAUDE.md — and
      // reports what it does through the hooks, so the steps and the permission
      // card show up in the island exactly as a terminal session's would. A
      // provider profile (openspec/changes/provider-chat-profiles) never
      // reaches a tool at all — the two are mutually exclusive in State.
      const text = State.agentCli
        ? await Bridge.agentSend(State.agentCli, prompt)
        : State.selectedProvider
          ? await Bridge.providerSend(State.selectedProvider, prompt, providerHistory(State.chatHistory))
          : await Promise.reject(
              new Error("No agent CLI found. Install Claude Code, or another agent CLI, and Coucou will pick it up."),
            );
      State.chatHistory.push({
        id: freshId(),
        role: "assistant",
        content: text,
        at: Date.now(),
        steps: State.chatSteps.slice(),
      });
      Sound.play("finish");
    } catch (err) {
      // Kept in the log, beside the question it answers. Switching the island
      // to the note view took the whole conversation off screen for what is
      // often one line about a flag.
      State.chatHistory.push({
        id: freshId(),
        role: "error",
        content: providerErrorMessage(String(err).replace(/^Error:\s*/, "")),
        at: Date.now(),
        steps: State.chatSteps.slice(),
      });
      Sound.play("error");
    } finally {
      State.stateOverride = null;
      State.chatDraft = "";
      State.chatSteps = [];
      sending = false;
      State.chatSending = false;
      // However the turn ended, this is the conversation the next run resumes.
      keepConversation();
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  send.addEventListener("click", () => {
    // The same button: there is only ever one thing to do to a turn, and it
    // changes from "send it" to "stop it" the moment it starts.
    if (sending) void Bridge.agentCancel();
    else void submit();
  });
  // The native picker (plan-v2.md § 5.3, Windows only this pass — see
  // bridge.ts's pickFiles) takes any file, any number; its empty result
  // (not in Tauri, cancelled, or no picker built for this platform yet) is
  // indistinguishable on purpose, and falls back to the Fase 4 HTML input,
  // which can only ever offer images.
  attachBtn.addEventListener("click", () => {
    void Bridge.pickFiles().then((paths) => {
      if (paths && paths.length > 0) void attach(paths);
      else fileInput.click();
    });
  });
  fileInput.addEventListener("change", () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = ""; // so picking the same file twice still fires "change"
    for (const file of files) {
      if (State.chatAttachments.length >= MAX_ATTACHMENTS) {
        State.noteMessage = tn("files.tooMany", MAX_ATTACHMENTS, { max: MAX_ATTACHMENTS });
        break;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        State.noteMessage = t("files.tooLarge", { name: file.name, max: "10 MB" });
        continue;
      }
      void ingestBlob(file);
    }
  });
  input.addEventListener("input", () => {
    highlighted = 0;
    syncPalette();
    autoGrow();
    State.notify(); // the send button's "nothing to send yet" dimming
  });
  // Composer keys: Ctrl+F find; Up/Down/Tab/Enter drive the `/` palette; Enter
  // sends (Shift+Enter = newline); Escape stops a turn or closes the find bar;
  // Up on an empty input recalls the last sent message. Propagation is stopped
  // so the island's own shortcuts do not fire while typing.
  input.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    const key = ke.key;
    if (ke.ctrlKey && key.toLowerCase() === "f") {
      e.preventDefault();
      e.stopPropagation();
      openFind(true);
      return;
    }
    const matches = currentMatches();
    if (matches.length > 0) {
      if (key === "ArrowDown" || key === "ArrowUp") {
        e.preventDefault();
        const step = key === "ArrowDown" ? 1 : matches.length - 1;
        highlighted = (highlighted + step) % matches.length;
        syncPalette();
        e.stopPropagation();
        return;
      }
      // Tab completes the command and leaves the cursor to add arguments;
      // Enter on an open palette would otherwise send a half-typed name.
      if (key === "Tab" || key === "Enter") {
        e.preventDefault();
        applyHighlighted();
        e.stopPropagation();
        return;
      }
    }
    if (key === "Enter" && !ke.shiftKey) {
      // Shift+Enter is left alone — the textarea's own newline.
      e.preventDefault();
      void submit();
      e.stopPropagation();
      return;
    }
    if (key === "Escape") {
      if (sending) {
        void Bridge.agentCancel();
        e.preventDefault();
      } else if (State.chatQuery !== null) {
        openFind(false);
        e.preventDefault();
      }
      // Otherwise left alone: Escape closes the island, not the chat.
    } else if (key === "ArrowUp" && input.value === "" && lastSentMessage) {
      // Recalls what this view itself last sent — never mid-edit, and never
      // when there is already something typed that `↑` would otherwise
      // clobber silently.
      input.value = lastSentMessage;
      autoGrow();
      input.setSelectionRange(input.value.length, input.value.length);
      e.preventDefault();
    }
    e.stopPropagation(); // Escape (when left alone) closes the island, not the chat
  });

  return {
    el,
    sync() {
      // The history, the draft and the shot tray are each keyed by what
      // changed about their own data — none of that notices a locale flip on
      // its own, so the sentinels below force each one to redraw on the next
      // pass through this function, same as a real content change would.
      if (getLocale() !== shownLocale) {
        shownLocale = getLocale();
        renderedCount = -1;
        renderedShots = "";
        renderedDraft = "";
      }

      const shotKey = State.chatAttachments.map((i) => i.path).join("|");
      if (shotKey !== renderedShots) {
        renderedShots = shotKey;
        clear(shotRow);
        for (const file of State.chatAttachments) {
          shotRow.append(
            attachmentTile(file, () => {
              State.chatAttachments = State.chatAttachments.filter((i) => i.path !== file.path);
              renderedShots = "";
              State.notify();
              onHeightChange();
            }),
          );
        }
      }

      if (State.chatHistory.length !== renderedCount) {
        renderedCount = State.chatHistory.length;
        clear(historyBox);
        State.chatHistory.forEach((message, i) => {
          const prev = State.chatHistory[i - 1];
          const precedingUserText = prev?.role === "user" ? prev.content : null;
          historyBox.append(bubble(message, precedingUserText, (q) => void submit(q)));
        });
        // After drawing, never before: the marks go into the rendered output,
        // so a repaint would throw them away. Searching the markup instead
        // would make a query for "code" hit every code tag.
        marks = State.chatQuery ? highlight(historyBox, State.chatQuery) : [];
        if (marks.length > 0) {
          current = Math.min(current, marks.length - 1);
          marks.forEach((mark, i) => mark.classList.toggle("on", i === current));
        }
      }

      // The draft is keyed by how much of it there is: enough to notice every
      // token without comparing the whole reply on every frame.
      const draftKey = sending ? `${State.chatDraft.length}|${State.chatSteps.length}` : "";
      if (draftKey !== renderedDraft) {
        renderedDraft = draftKey;
        clear(draftBox);
        if (sending) draftBox.append(draftRow());
      }
      if (stick) log.scrollTop = log.scrollHeight;

      // The header's own Mochi, and the bigger one the empty log shows before
      // the first message — the same engine as the console grid's fichas and
      // the service pills (src/mochi/minibots.ts), in place of the big one
      // every other view uses off to the side (which the chat no longer draws
      // room for — see .chat-body's padding, and VIEW_LAYOUTS.prompt in
      // core/layout.ts). "thinking" while a turn is in flight is as far as
      // this phase takes its mood; eyes following the streamed text and the
      // health/sickness range are Fase 7's (docs/plan-v2.md § 7).
      const avatarKey = `${State.agentCli ?? ""}|${sending}`;
      if (avatarKey !== renderedAvatar) {
        renderedAvatar = avatarKey;
        const task = {
          id: "chat-avatar",
          name: "",
          color: consoleColor(State.agentCli ?? ""),
          state: sending ? ("thinking" as const) : ("idle" as const),
          stepIndex: 0,
          steps: [],
          source: "agent" as const,
          isIntegration: false,
        };
        clear(avatarSlot);
        avatarSlot.append(createMiniBot(task, 24));
        clear(emptyAvatarSlot);
        emptyAvatarSlot.append(createMiniBot({ ...task, id: "chat-empty-avatar" }, 64));
        clear(dropAvatar);
        dropAvatar.append(stillMiniBot(task.color, 36));
        pruneMiniBots();
      }
      emptyState.classList.toggle("on", State.chatHistory.length === 0 && !sending);
      // The native Tauri drag path (island.ts) sets this; the browser's own
      // dragenter/dragover (dropZone, below) sets the same class directly,
      // for mock mode and plain-browser dev where Tauri's own event never
      // fires. Either one shows the same overlay.
      dropZone.classList.toggle("dropping", State.fileDragOver);

      provider.textContent = providerLabel();
      const attached = State.attachedProject;
      // The folder name is enough to recognise it; the full path is the title.
      projectBtn.textContent = attached ? lastPathComponent(attached) : t("chat.attachProject");
      projectBtn.title = attached
        ? t("chat.detachProject", { path: attached })
        : t("chat.chooseProjectFolder");
      projectBtn.classList.toggle("on", attached != null);

      findBtn.classList.toggle("on", State.chatQuery !== null);
      moreBtn.classList.toggle("on", State.chatExpanded);

      clear(send);
      send.append(icon(sending ? "stop" : "arrowUp", { size: sending ? 9 : 11 }));
      send.title = sending ? t("chat.stopTurn") : t("chat.send");
      send.classList.toggle("stopping", sending);
      send.classList.toggle("empty", !sending && input.value.trim() === "" && State.chatAttachments.length === 0);

      input.placeholder = placeholder();
      input.disabled = sending;
      syncPalette();
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
