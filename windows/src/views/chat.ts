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
  keepConversation,
  matchingCommands,
  nextProvider,
  providerLabel,
  toggleProject,
} from "../island/agent";
import type { ViewHost } from "./views";

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

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
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
      ? `${plural(steps.length, "step")} · hide`
      : live
        ? steps[steps.length - 1]
        : plural(steps.length, "step");
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
  const copy = h("button", { class: "msg-btn", title: "Copy the reply" }, icon("copy", { size: 10 }));
  copy.addEventListener("click", () => {
    void copyToClipboard(content).then((done) => {
      clear(copy);
      copy.append(icon(done ? "check" : "bang", { size: 10 }));
      copy.title = done ? "Copied" : "Could not copy";
      window.setTimeout(() => {
        clear(copy);
        copy.append(icon("copy", { size: 10 }));
        copy.title = "Copy the reply";
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
  const more = h("button", { class: "more-btn", text: "Show the whole reply" });
  more.addEventListener("click", () => {
    const folded = body.classList.toggle("clipped");
    more.textContent = folded ? "Show the whole reply" : "Fold it back up";
  });
  return h("div", { class: "reply-wrap" }, body, more);
}

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content, title: clockOf(message.at) }),
    );
  }

  if (message.role === "error") {
    const card = h(
      "div",
      { class: "reply-error", title: clockOf(message.at) },
      h("div", { class: "reply-error-head" }, icon("bang", { size: 10 }), h("span", { text: "The turn stopped" })),
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
    column.append(h("div", { class: "reply quiet", text: "No reply came back." }));
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
  const drop = h("button", { class: "shot-drop", title: `Remove ${file.name}` });
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
  if (!State.agentCli) return "No agent CLI found — install one to chat…";
  if (!State.attachedProject) return "Attach a project folder first…";
  if (State.chatHistory.length > 0) return "Continue…";
  return "Ask, or / for a command…";
}

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const shotRow = h("div", { class: "shot-row" });
  const log = h("div", { class: "chat-log" });
  // Rebuilt on their own schedules: the history only when a message lands, the
  // draft on every frame a token arrives in.
  const historyBox = h("div", { class: "chat-stack" });
  const draftBox = h("div", { class: "chat-stack" });
  log.append(historyBox, draftBox);
  const jump = h("button", { class: "jump-btn", title: "Jump to the latest" }, icon("arrowDown", { size: 10 }));
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, icon("arrowUp", { size: 11 }));
  const bar = h("div", { class: "chat-bar" }, input, send);

  // The header carries the two things that decide what a message does: which
  // agent runs it, and where. Both read as plain text until hovered, so an
  // ordinary question is not surrounded by machinery.
  const provider = h("button", {
    class: "chat-meta-btn",
    title: "Switch between the installed agent consoles",
  });
  const projectBtn = h("button", { class: "chat-meta-btn" });
  const findBtn = h("button", { class: "chat-icon-btn", title: "Find in the conversation (Ctrl+F)" });
  findBtn.append(icon("search", { size: 11 }));
  const growBtn = h("button", { class: "chat-icon-btn" });
  const header = h(
    "div",
    { class: "chat-meta" },
    provider,
    h("span", { class: "grow" }),
    projectBtn,
    findBtn,
    growBtn,
  );

  // ── The find bar ────────────────────────────────────────────────────────
  //
  // What it can reach is the island's own log — the last forty messages kept
  // in chat.json — and not the CLI's full history. The counter counts what is
  // there, which is the honest way to say so.
  const findInput = h("input", {
    type: "text",
    class: "find-input",
    placeholder: "Find in the conversation…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const findCount = h("span", { class: "find-count" });
  const prevBtn = h("button", { class: "chat-icon-btn", title: "Previous (Shift+Enter)" });
  prevBtn.append(icon("arrowUp", { size: 10 }));
  const nextBtn = h("button", { class: "chat-icon-btn", title: "Next (Enter)" });
  nextBtn.append(icon("arrowDown", { size: 10 }));
  const closeFind = h("button", { class: "chat-icon-btn", title: "Close (Escape)" });
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

  let sending = false;
  let renderedCount = -1;
  let renderedDraft = "";
  let renderedShots = "";
  let paletteKey = "";
  let highlighted = 0;
  /** Whether new text should scroll into view — false once the user reads back. */
  let stick = true;
  /** Every hit for the current query, and which one is current. */
  let matches: Match[] = [];
  let current = 0;
  /** Marks placed by the last highlight pass, in document order. */
  let marks: HTMLElement[] = [];

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
  findInput.addEventListener("input", () => runFind(findInput.value));
  findInput.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    event.stopPropagation();
    if (key === "Escape") openFind(false);
    else if (key === "Enter") goToMatch((event as KeyboardEvent).shiftKey ? -1 : 1);
  });

  growBtn.addEventListener("click", () => {
    State.chatExpanded = !State.chatExpanded;
    State.notify();
    onHeightChange();
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
        State.noteMessage = `Up to ${MAX_IMAGES} images on one message.`;
        break;
      }
      if (!/\.(png|jpe?g|webp|gif)$/i.test(path)) continue;
      try {
        const file = await Bridge.ingestFile(path);
        if (file.size > MAX_IMAGE_BYTES) {
          State.noteMessage = `${file.name} is larger than 10 MB.`;
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

  /** Pasting is the one way an image arrives with no path to copy from. */
  input.addEventListener("paste", (event) => {
    const items = (event as ClipboardEvent).clipboardData?.items ?? [];
    for (const item of items) {
      if (!item.type.startsWith("image/")) continue;
      const blob = item.getAsFile();
      if (!blob) continue;
      event.preventDefault();
      void blob.arrayBuffer().then(async (buffer) => {
        try {
          const file = await Bridge.pasteImage(item.type, [...new Uint8Array(buffer)]);
          State.chatImages.push(file);
          renderedShots = "";
          State.notify();
          onHeightChange();
        } catch (err) {
          State.noteMessage = String(err).replace(/^Error:\s*/, "");
          State.notify();
        }
      });
      return;
    }
  });

  intoChat = (paths) => void attach(paths);

  void onEvent<AgentTurn>("agent-turn", (turn) => {
    if (turn.kind === "text") State.chatDraft += turn.text;
    else State.chatSteps.push(turn.label);
    paint();
  });

  provider.addEventListener("click", () => {
    nextProvider();
    input.focus();
  });
  projectBtn.addEventListener("click", () => {
    void toggleProject().then(() => input.focus());
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

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    input.value = "";
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
  input.addEventListener("input", () => {
    highlighted = 0;
    syncPalette();
  });
  input.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if ((e as KeyboardEvent).ctrlKey && key.toLowerCase() === "f") {
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
    if (key === "Enter") {
      e.preventDefault();
      void submit();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    sync() {
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
        for (const message of State.chatHistory) historyBox.append(bubble(message));
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

      provider.textContent = providerLabel();
      const attached = State.attachedProject;
      // The folder name is enough to recognise it; the full path is the title.
      projectBtn.textContent = attached ? lastPathComponent(attached) : "Attach project…";
      projectBtn.title = attached ? `${attached} — click to detach` : "Choose the folder the agent works in";
      projectBtn.classList.toggle("on", attached != null);

      findBtn.classList.toggle("on", State.chatQuery !== null);
      clear(growBtn);
      growBtn.append(icon(State.chatExpanded ? "chevronLeft" : "chevronRight", { size: 11 }));
      growBtn.title = State.chatExpanded ? "Make the chat smaller" : "Use the whole height";
      growBtn.classList.toggle("on", State.chatExpanded);

      clear(send);
      send.append(icon(sending ? "stop" : "arrowUp", { size: sending ? 9 : 11 }));
      send.title = sending ? "Stop this turn" : "Send";
      send.classList.toggle("stopping", sending);

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
