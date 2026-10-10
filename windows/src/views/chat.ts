// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift.

import { h, clear, copyToClipboard } from "./dom";
import { icon } from "./icons";
import { render } from "./markdown";
import { counter, findMatches, highlight, step, type Match } from "./search";
import { Bridge, onEvent, type AgentTurn, type DroppedFile } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import {
  availableClis,
  chooseProvider,
  detachProject,
  keepConversation,
  matchingCommands,
  pickProject,
  providerLabel,
  startFreshConversation,
} from "../island/agent";
import { orderConsoles } from "../consoles/order";
import { consoleColor } from "../consoles/palette";
import { stillMiniBot, createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { inlineConfirm } from "../ui/inline-confirm";
import type { ViewHost } from "./views";
import { t, tn, getLocale } from "../i18n/index";

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

/** Copy — the one thing worth doing to a reply that is already on screen. */
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
  return h("div", { class: "msg-actions" }, copy);
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
function bubble(message: ChatMessage, precedingUserText: string | null, onRetry: (query: string) => void): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content, title: clockOf(message.at) }),
    );
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

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

/**
 * The chat's way in for dropped images, set when the view is built.
 *
 * The island owns the drop event — Tauri delivers it to the window, not to an
 * element — so it has to be able to hand the paths to whichever view wants
 * them. One function rather than an event, because there is exactly one chat.
 */
let intoChat: ((paths: string[]) => void) | null = null;

/** Called by the island when a drop lands while the chat is open. */
export function takeChatImages(paths: string[]) {
  intoChat?.(paths);
}

/** How many images may ride on one message, and how large each may be. */
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * One attached image.
 *
 * The thumbnail is asked for by path and arrives as a data URI, because the
 * webview never holds file bytes: Tauri intercepts the drop and hands over
 * paths only, so `URL.createObjectURL` has nothing to work with here. A file
 * too large to inline keeps its chip and loses only the picture.
 */
function imageChip(file: DroppedFile, onRemove: () => void): HTMLElement {
  const thumb = h("span", { class: "shot-thumb" });
  const drop = h("button", { class: "shot-drop", title: t("chat.removeImage", { name: file.name }) });
  drop.append(icon("xmark", { size: 9 }));
  drop.addEventListener("click", onRemove);

  const chip = h(
    "div",
    { class: "shot", title: file.path },
    thumb,
    h("span", { class: "shot-name", text: file.name }),
    drop,
  );

  void Bridge.imagePreview(file.path)
    .then((url) => {
      const img = h("img", { src: url, alt: "" });
      thumb.append(img);
    })
    .catch(() => {
      // Too large to inline, or not an image Coucou shows. The chip stays:
      // the agent still gets the path, which is the part that matters.
      thumb.append(icon("image", { size: 11 }));
    });

  return chip;
}

function lastPathComponent(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * The placeholder is the only thing telling the user why a message might not
 * do what they expect, so it names the one blocker rather than a generic hint.
 */
function placeholder(): string {
  if (!State.agentCli) return t("chat.placeholderNoCli");
  if (!State.attachedProject) return t("chat.placeholderNoProject");
  if (State.chatHistory.length > 0) return t("chat.placeholderContinue");
  return t("chat.placeholderAsk");
}

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
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

  const el = h(
    "div",
    { class: "view" },
    h(
      "div",
      { class: "card wash chat-card" },
      h(
        "div",
        { class: "chat-body" },
        header,
        findBar,
        chipRow,
        log,
        jump,
        palette,
        shotRow,
        bar,
      ),
    ),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

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

  let sending = false;
  let renderedCount = -1;
  let renderedDraft = "";
  let renderedShots = "";
  let renderedAvatar = "";
  let shownLocale = getLocale();
  let paletteKey = "";
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
   * Takes images into the tray, refusing what cannot ride along and saying why.
   *
   * Every file goes through `ingest_file` first, which copies it into the inbox
   * without ever overwriting — so the original is untouched and the copy
   * survives the folder it came from going away mid-conversation.
   */
  async function attach(paths: string[]) {
    for (const path of paths) {
      if (State.chatImages.length >= MAX_IMAGES) {
        State.noteMessage = tn("files.tooManyImages", MAX_IMAGES, { max: MAX_IMAGES });
        break;
      }
      if (!/\.(png|jpe?g|webp|gif)$/i.test(path)) continue;
      try {
        const file = await Bridge.ingestFile(path);
        if (file.size > MAX_IMAGE_BYTES) {
          State.noteMessage = t("files.tooLarge", { name: file.name, max: "10 MB" });
          continue;
        }
        State.chatImages.push(file);
      } catch (err) {
        void Bridge.log(`attach failed: ${String(err)}`);
      }
    }
    renderedShots = "";
    State.notify();
    onHeightChange();
  }

  /** The chat's own drop target, used while the chat is the open view. */
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
      State.chatImages.push(file);
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

  intoChat = (paths) => void attach(paths);

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

  provider.addEventListener("click", () => {
    // Nothing to switch to — opening an empty popover would be worse than
    // the click doing nothing, same as nextProvider() used to no-op here.
    if (availableClis.length === 0) return;
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
    });
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

  function applyHighlighted() {
    const matches = currentMatches();
    const chosen = matches[highlighted];
    if (!chosen) return false;
    input.value = `/${chosen.name} `;
    syncPalette();
    return true;
  }

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
    if (!query || sending) return;
    if (forcedQuery == null) {
      input.value = "";
      autoGrow();
    }
    lastSentMessage = query;
    highlighted = 0;
    syncPalette();
    sending = true;
    Sound.play("send");

    State.chatHistory.push({ id: freshId(), role: "user", content: query, at: Date.now() });
    State.chatDraft = "";
    State.chatSteps = [];
    stick = true;
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    // The agent is told where things are rather than handed their bytes: it
    // can open a file itself, which is the whole point of running the real
    // CLI. Images attached to this message go the same way, by path.
    const shots = State.chatImages.slice();
    State.chatImages = [];
    renderedShots = "";

    const file = State.droppedFile;
    const parts = [query];
    if (shots.length > 0) {
      parts.push(
        shots.length === 1
          ? `The image this is about: ${shots[0].path}`
          : `The images this is about:\n${shots.map((s) => `- ${s.path}`).join("\n")}`,
      );
    } else if (State.chatHistory.length === 1 && file?.path) {
      parts.push(`The file this is about: ${file.path}`);
    }
    const prompt = parts.join("\n\n");

    try {
      // The CLI runs the real agent — its own tools, skills and CLAUDE.md — and
      // reports what it does through the hooks, so the steps and the permission
      // card show up in the island exactly as a terminal session's would.
      const text = State.agentCli
        ? await Bridge.agentSend(State.agentCli, prompt)
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
        content: String(err).replace(/^Error:\s*/, ""),
        at: Date.now(),
        steps: State.chatSteps.slice(),
      });
      Sound.play("error");
    } finally {
      State.stateOverride = null;
      State.chatDraft = "";
      State.chatSteps = [];
      sending = false;
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
  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = ""; // so picking the same file twice still fires "change"
    for (const file of files) {
      if (State.chatImages.length >= MAX_IMAGES) {
        State.noteMessage = tn("files.tooManyImages", MAX_IMAGES, { max: MAX_IMAGES });
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

      const file = State.droppedFile;
      const wantChip = file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }

      const shotKey = State.chatImages.map((i) => i.path).join("|");
      if (shotKey !== renderedShots) {
        renderedShots = shotKey;
        clear(shotRow);
        for (const file of State.chatImages) {
          shotRow.append(
            imageChip(file, () => {
              State.chatImages = State.chatImages.filter((i) => i.path !== file.path);
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
        pruneMiniBots();
      }
      emptyState.classList.toggle("on", State.chatHistory.length === 0 && !sending);

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
      send.classList.toggle("empty", !sending && input.value.trim() === "" && State.chatImages.length === 0);

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
