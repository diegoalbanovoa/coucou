// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, type ChatContext } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import {
  matchingCommands,
  nextProvider,
  providerLabel,
  toggleProject,
} from "../island/agent";
import type { ViewHost } from "./views";

let nextId = 1;

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  return h("div", { class: "chat-row" }, h("div", { class: "reply", text: message.content }));
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
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
  if (State.agentCli && !State.attachedProject) return "Attach a project folder first…";
  if (State.chatHistory.length > 0) return "Continue…";
  return State.agentCli ? "Ask, or / for a command…" : "Ask me anything…";
}

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
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
      h("div", { class: "chat-body" }, header, chipRow, log, palette, bar),
    ),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  let renderedCount = -1;
  let paletteKey = "";
  let highlighted = 0;

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

    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    const file = State.droppedFile;
    const context: ChatContext | null =
      State.chatHistory.length === 1 && file ? { kind: "file", name: file.name, path: file.path } : null;

    try {
      // A CLI runs the real agent — its own tools, skills and CLAUDE.md — and
      // reports what it does through the hooks, so the steps and the
      // permission card show up in the island exactly as a terminal session's
      // would. The API path stays for anyone with a key and no CLI.
      const text = State.agentCli
        ? await Bridge.agentSend(State.agentCli, query)
        : (await Bridge.chatSend(query, context)).text;
      State.chatHistory.push({ id: nextId++, role: "assistant", content: text });
      State.stateOverride = null;
      Sound.play("finish");
    } catch (err) {
      State.stateOverride = null;
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      sending = false;
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  send.addEventListener("click", () => void submit());
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

      const thinking = State.stateOverride === "thinking";
      const count = State.chatHistory.length + (thinking ? 0.5 : 0);
      if (count !== renderedCount) {
        renderedCount = count;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m));
        if (thinking) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }

      provider.textContent = providerLabel();
      const attached = State.attachedProject;
      // The folder name is enough to recognise it; the full path is the title.
      projectBtn.textContent = attached ? lastPathComponent(attached) : "Attach project…";
      projectBtn.title = attached ? `${attached} — click to detach` : "Choose the folder the agent works in";
      projectBtn.classList.toggle("on", attached != null);

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
