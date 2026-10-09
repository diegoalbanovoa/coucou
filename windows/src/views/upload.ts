// Drop zone, upload progress and the "what do you want to do with it" card —
// ports of UploadView / UploadingView / ChooseView from IslandViewContent.swift.
//
// Sending a file by email is not in the Windows v1, so `choose` offers the one
// action the spec asks for: ask a question about it.

import { h, clear } from "./dom";
import { State } from "../core/state";
import type { ViewActions, ViewHost } from "./views";
import { t } from "../i18n/index";

/** Dashed rounded rect drawn as SVG so the dashes can march like on macOS. */
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
  rect.setAttribute("rx", "20");
  rect.setAttribute("fill", "none");
  rect.setAttribute("stroke-width", "1.5");
  rect.setAttribute("stroke-dasharray", "6 5");
  el.append(rect);
  return el;
}

export function buildUpload(): ViewHost {
  const frame = dashedFrame();
  const title = h("div", { class: "drop-title" });
  const tagPdf = h("span", {});
  const tagImages = h("span", {});
  const tagCode = h("span", {});
  const tagDocs = h("span", {});
  const tags = h("div", { class: "drop-tags" }, tagPdf, tagImages, tagCode, tagDocs);
  const card = h(
    "div",
    { class: "card drop-card" },
    frame,
    h("div", { class: "drop-body" }, title, tags),
  );
  const el = h("div", { class: "view" }, card);

  return {
    el,
    sync() {
      card.classList.toggle("over", State.fileDragOver);
      title.textContent = t("files.dropTitle");
      tagPdf.textContent = t("files.kind.pdf");
      tagImages.textContent = t("files.kind.images");
      tagCode.textContent = t("files.kind.code");
      tagDocs.textContent = t("files.kind.docs");
    },
  };
}

export function buildUploading(): ViewHost {
  const label = h("span", { class: "up-name" });
  const percent = h("span", { class: "up-pct" });
  const fill = h("div", { class: "up-fill" });
  const glow = h("div", { class: "up-glow" });
  const card = h(
    "div",
    { class: "card up-card" },
    h("div", { class: "up-row" }, label, percent),
    h("div", { class: "up-track" }, fill, glow),
  );
  const el = h("div", { class: "view" }, card);

  return {
    el,
    sync() {
      const done = State.uploadProgress >= 0.999;
      const pct = Math.round(State.uploadProgress * 100);
      const name = State.droppedFile?.name ?? t("files.uploadingFallback");
      label.textContent = done ? t("files.uploaded", { name }) : t("files.uploading", { name });
      label.classList.toggle("done", done);
      percent.textContent = done ? "" : `${pct} %`;
      const w = State.uploadProgress * 526;
      fill.style.width = `${w}px`;
      glow.style.transform = `translateX(${Math.max(0, w - 14)}px)`;
      glow.style.opacity = State.uploadProgress > 0.01 ? "1" : "0";
      card.classList.toggle("done", done);
    },
  };
}

export function buildChoose(actions: ViewActions): ViewHost {
  const title = h("div", { class: "title" });
  const sub = h("div", { class: "sub" });
  const askBtn = h("button", { class: "btn primary", onclick: () => actions.setView("prompt") });
  const cancelBtn = h("button", {
    class: "btn secondary",
    onclick: () => actions.setView(State.defaultView()),
  });
  const row = h("div", { class: "actions" }, askBtn, cancelBtn);
  const el = h(
    "div",
    { class: "view" },
    h(
      "div",
      { class: "card" },
      h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title, sub, row),
    ),
  );

  return {
    el,
    sync() {
      sub.textContent = t("files.whatNow");
      askBtn.textContent = t("files.askQuestion");
      cancelBtn.textContent = t("common.cancel");
      clear(title);
      title.append(
        h("b", { text: State.droppedFile?.name ?? t("files.readyFileFallback") }),
        document.createTextNode(t("files.readySuffix")),
      );
    },
  };
}
