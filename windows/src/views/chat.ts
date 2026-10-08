// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift.

import { h, svg, clear, copyToClipboard } from "./dom";
import { ICONS } from "./icons";
import { render } from "./markdown";
import { Bridge, onEvent, type AgentTurn } from "../core/bridge";
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
  const copy = h("button", { class: "msg-btn", title: "Copy the reply" }, svg(ICONS.copy, 10));
  copy.addEventListener("click", () => {
    void copyToClipboard(content).then((done) => {
      clear(copy);
      copy.append(svg(done ? ICONS.check : ICONS.bang, 10));
      copy.title = done ? "Copied" : "Could not copy";
      window.setTimeout(() => {
        clear(copy);
        copy.append(svg(ICONS.copy, 10));
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
      h("div", { class: "reply-error-head" }, svg(ICONS.bang, 10), h("span", { text: "The turn stopped" })),
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
  const log = h("div", { class: "chat-log" });
  // Rebuilt on their own schedules: the history only when a message lands, the
  // draft on every frame a token arrives in.
  const historyBox = h("div", { class: "chat-stack" });
  const draftBox = h("div", { class: "chat-stack" });
  log.append(historyBox, draftBox);
  const jump = h("button", { class: "jump-btn", title: "Jump to the latest" }, svg(ICONS.arrowDown, 10));
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, input, send);

  // The header carries the two things that decide what a message does: which
  // agent runs it, and where. Both read as plain text until hovered, so an
  // ordinary question is not surrounded by machinery.
  const provider = h("button", {
    class: "chat-meta-btn",
    title: "Switch between the installed agent CLIs and the Claude API",
  });
  const projectBtn = h("button", { class: "chat-meta-btn" });
  const header = h("div", { class: "chat-meta" }, provider, h("span", { class: "grow" }), projectBtn);

  // `/` autocomplete. Hidden unless the input starts with a slash.
  const palette = h("div", { class: "slash-palette" });

  const el = h(
    "div",
    { class: "view" },
    h(
      "div",
      { class: "card wash chat-card" },
      h("div", { class: "chat-body" }, header, chipRow, log, jump, palette, bar),
    ),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  let renderedCount = -1;
  let renderedDraft = "";
  let paletteKey = "";
  let highlighted = 0;
  /** Whether new text should scroll into view — false once the user reads back. */
  let stick = true;

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

    // A dropped file is only context for the first question about it, and the
    // agent is told where it is rather than handed its bytes: it can open the
    // file itself, which is the whole point of running the real CLI.
    const file = State.droppedFile;
    const prompt =
      State.chatHistory.length === 1 && file?.path
        ? `${query}\n\nThe file this is about: ${file.path}`
        : query;

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

      if (State.chatHistory.length !== renderedCount) {
        renderedCount = State.chatHistory.length;
        clear(historyBox);
        for (const message of State.chatHistory) historyBox.append(bubble(message));
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

      clear(send);
      send.append(svg(sending ? ICONS.stop : ICONS.arrowUp, sending ? 9 : 11));
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
