// Minimal DOM helpers — no framework, as specified.
// Imported by practically every view and ui component.

/** Attribute bag for [h]: `on*` keys with a function value become listeners. */
type Attrs = Record<string, string | number | boolean | EventListener | undefined>;
/** Anything [h] accepts as a child; null/undefined/false are skipped. */
type Child = Node | string | null | undefined | false;

/**
 * Hyperscript-style element factory. Special keys: `class`, `text`
 * (textContent), `html` (innerHTML — callers must pass trusted markup only),
 * `style` (raw attribute string) and `onclick`-style listeners; `true` sets a
 * boolean attribute, `false`/null skips it. Strings are added as text nodes.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else if (k === "html") el.innerHTML = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "style") el.setAttribute("style", String(v));
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

/** Removes every child of `el`. */
export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Card dot used in every "who" row. */
export function dot(color: string, size = 7): HTMLElement {
  return h("i", {
    class: "dot",
    style: `width:${size}px;height:${size}px;background:${color}`,
  });
}

/**
 * Puts `text` on the clipboard. The async API is the one that works in the
 * webview; the textarea is for when it is refused, which is what happens
 * without a secure context.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      return copied;
    } catch {
      return false;
    }
  }
}
