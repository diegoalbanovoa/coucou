// One icon system for the whole app.
//
// Every icon is drawn on a 24×24 grid, carries no colour of its own, and is
// sized in `em` — so it inherits `currentColor` from the button around it, and
// scales with the text beside it and with the Windows display scale without a
// single call site changing. A button's hover, active and disabled states are
// therefore a CSS matter, never a second icon.
//
// Most are stroked: a 1.75-wide line with round caps and joins reads cleanly at
// 11 px and at 200% scale alike, where a filled silhouette turns to mush. The
// handful marked `solid` are shapes a stroke cannot say — a stop square, a
// gear's teeth, a speaker's cone.
//
// Replaced a set of filled paths ported from the macOS app's SF Symbols. Kept
// their names where the meaning is the same, so the island's vocabulary did not
// change along with its drawing.

export interface IconDef {
  /** Paths on the 24×24 grid. */
  d: string[];
  /** Filled rather than stroked. */
  solid?: boolean;
}

/** Line weight every stroked icon is drawn with. */
export const STROKE = 1.75;

export const ICONS = {
  // ── Navigation and chrome ────────────────────────────────────────────────
  house: { d: ["M3.2 11.2 12 4l8.8 7.2", "M5.6 9.8V20h12.8V9.8", "M10 20v-5.2h4V20"] },
  bubble: { d: ["M4 5.6h16v10.2H9.4L5.4 19.4v-3.6H4z"] },
  plus: { d: ["M12 5.2v13.6", "M5.2 12h13.6"] },
  search: { d: ["M10.8 4.4a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8z", "M15.6 15.6 20 20"] },
  folder: { d: ["M3.4 6.6h5.6l2 2.2h9.6V18a1.4 1.4 0 0 1-1.4 1.4H4.8A1.4 1.4 0 0 1 3.4 18z"] },
  image: {
    d: [
      "M4 5.4h16v13.2H4z",
      "M4 15.4l4.6-4.2 3.6 3.2 3.2-2.8L20 15",
      "M9.2 9.4a1.3 1.3 0 1 0 0-.02z",
    ],
  },
  gear: {
    solid: true,
    d: [
      "M10.9 2h2.2l.35 2.1c.6.17 1.16.4 1.67.71l1.9-1 1.55 1.55-1 1.9c.3.5.54 1.07.7 1.67l2.13.35v2.2l-2.12.35c-.17.6-.4 1.16-.71 1.67l1 1.9-1.55 1.55-1.9-1c-.5.3-1.07.54-1.67.7L13.1 22h-2.2l-.35-2.12c-.6-.17-1.16-.4-1.67-.71l-1.9 1L5.43 18.6l1-1.9c-.3-.5-.54-1.07-.7-1.67L3.6 14.7v-2.2l2.12-.35c.17-.6.4-1.16.71-1.67l-1-1.9 1.55-1.55 1.9 1c.5-.3 1.07-.54 1.67-.7zM12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z",
    ],
  },
  speakerOn: {
    solid: true,
    d: [
      "M11 4.5 6.5 8.2H3.4v7.6h3.1L11 19.5v-15zm3.2 3a5.3 5.3 0 0 1 0 9 .9.9 0 0 0 .9 1.55 7.1 7.1 0 0 0 0-12.1.9.9 0 0 0-.9 1.55z",
    ],
  },
  speakerOff: {
    solid: true,
    d: [
      "M11 4.5 6.5 8.2H3.4v7.6h3.1L11 19.5v-15zm3.6 4.1 1.27-1.27 2.33 2.33 2.33-2.33 1.27 1.27L19.47 11l2.33 2.33-1.27 1.27-2.33-2.33-2.33 2.33-1.27-1.27L16.93 11z",
    ],
  },

  // ── Actions ──────────────────────────────────────────────────────────────
  arrowUp: { d: ["M12 19.2V5.4", "M6 11.4 12 5.4l6 6"] },
  arrowDown: { d: ["M12 4.8v13.8", "M18 12.6 12 18.6l-6-6"] },
  arrowUpRight: { d: ["M7.4 16.6 16.6 7.4", "M9.6 7.4h7v7"] },
  chevronRight: { d: ["M9.4 5.4 16 12l-6.6 6.6"] },
  chevronLeft: { d: ["M14.6 5.4 8 12l6.6 6.6"] },
  check: { d: ["M4.8 12.6 9.6 17.4 19.2 6.8"] },
  xmark: { d: ["M6 6l12 12", "M18 6 6 18"] },
  copy: { d: ["M9 9h10.4v10.4H9z", "M14.8 9V4.6H4.4V15h4.4"] },
  stop: { solid: true, d: ["M6.6 6.6h10.8v10.8H6.6z"] },
  refresh: { d: ["M19.4 12a7.4 7.4 0 1 1-2.6-5.65", "M19.4 4.6v4.2h-4.2"] },
  broom: { d: ["M14.6 4.6 19.4 9.4", "M12.4 6.8 17.2 11.6 9.6 19.2H4.4v-5.2z", "M8 11.2l4.8 4.8"] },

  // ── Status and system ────────────────────────────────────────────────────
  bang: { d: ["M12 5.4v8.4", "M12 17.4v1.2"] },
  timer: { d: ["M12 5.4a7.2 7.2 0 1 0 0 14.4 7.2 7.2 0 0 0 0-14.4z", "M12 9.6V12l2.6 1.8", "M9.4 2.8h5.2"] },
  ellipsis: { d: ["M6.2 12h.02", "M12 12h.02", "M17.8 12h.02"] },
  doc: { d: ["M6.6 3.4h7.2l4.2 4.2v13H6.6z", "M13.4 3.4v4.4h4.4", "M9.4 12.6h5.2", "M9.4 16h5.2"] },
  stack: { d: ["M5.4 8.6h13.2v11H5.4z", "M7.2 5.8h9.6", "M8.8 3.4h6.4"] },
  star: { d: ["M12 4.2l2.4 5 5.4.76-3.9 3.86.94 5.42L12 16.66l-4.84 2.58.94-5.42-3.9-3.86 5.4-.76z"] },
  cpu: { d: ["M8.6 8.6h6.8v6.8H8.6z", "M6 6h12v12H6z", "M10 3.4v2.6", "M14 3.4v2.6", "M10 18v2.6", "M14 18v2.6", "M3.4 10H6", "M3.4 14H6", "M18 10h2.6", "M18 14h2.6"] },
  memory: { d: ["M3.6 7.4h16.8v9.2H3.6z", "M7.4 10.4v3.2", "M10.8 10.4v3.2", "M14.2 10.4v3.2", "M17.6 10.4v3.2"] },
  disk: { d: ["M3.6 12.4h16.8v6H3.6z", "M6.2 5.2h11.6l2.6 7.2H3.6z", "M6.6 15.4h.02", "M17.4 15.4h3"] },
} as const satisfies Record<string, IconDef>;

export type IconName = keyof typeof ICONS;

const NS = "http://www.w3.org/2000/svg";

/**
 * One icon, ready to append.
 *
 * `size` is a CSS length and defaults to `1em`, which is what makes an icon
 * follow the text around it. Pass a number only where an icon has to be a
 * fixed pixel size whatever the type does.
 */
export function icon(name: IconName, opts: { size?: string | number; title?: string } = {}): SVGSVGElement {
  const def: IconDef = ICONS[name];
  const el = document.createElementNS(NS, "svg");
  const size = typeof opts.size === "number" ? `${opts.size}px` : (opts.size ?? "1em");

  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", size);
  el.setAttribute("height", size);
  el.setAttribute("fill", "none");
  // Decorative by default: the label is on the button, and a second reading of
  // the same word is noise. A title makes it an image with a name instead.
  if (opts.title) {
    el.setAttribute("role", "img");
    const title = document.createElementNS(NS, "title");
    title.textContent = opts.title;
    el.append(title);
  } else {
    el.setAttribute("aria-hidden", "true");
  }

  for (const d of def.d) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    if (def.solid) {
      path.setAttribute("fill", "currentColor");
    } else {
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", String(STROKE));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
    }
    el.append(path);
  }
  return el;
}
