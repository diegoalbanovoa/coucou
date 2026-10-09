// A back-stack confined to one container — like a small `NavigationStack`
// that never leaves the card it started in, because the card is not allowed
// to grow (rule 6, docs/plan-v2.md § 1). The console detail in Fase 3.5 is
// the first thing that pushes onto one: "‹ Consoles" over a fixed-height
// right card, with the session list scrolling inside it rather than the card
// growing to fit.

import { h } from "../views/dom";
import { icon } from "../views/icons";

export interface PushNav {
  el: HTMLElement;
  push(title: string, body: Node): void;
  pop(): void;
  readonly depth: number;
}

export function pushNav(root: Node): PushNav {
  const el = h("div", { class: "ui-push-nav" });
  const frames: HTMLElement[] = [h("div", { class: "ui-push-frame" }, root)];
  el.append(frames[0]);

  function pop() {
    if (frames.length < 2) return;
    const leaving = frames.pop()!;
    leaving.classList.add("ui-push-leave");
    leaving.addEventListener("transitionend", () => leaving.remove(), { once: true });
    frames[frames.length - 1].classList.remove("ui-push-hidden");
  }

  function push(title: string, body: Node) {
    const back = h(
      "button",
      { class: "ui-push-back", onclick: pop },
      icon("chevronLeft", { size: 11 }),
      h("span", { text: title }),
    );
    const frame = h(
      "div",
      { class: "ui-push-frame ui-push-enter" },
      h("div", { class: "ui-push-head" }, back),
      body,
    );
    frames[frames.length - 1].classList.add("ui-push-hidden");
    frames.push(frame);
    el.append(frame);
    // The entering class has to be removed on a later frame, or the browser
    // coalesces its own addition and removal and the transition never plays.
    requestAnimationFrame(() => frame.classList.remove("ui-push-enter"));
  }

  return {
    el,
    push,
    pop,
    get depth() {
      return frames.length;
    },
  };
}
