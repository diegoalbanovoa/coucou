// Pure logic for the console grid: what order the fichas come in, how they
// split into pages of four, and what state each one is in — none of it
// needs a DOM, so none of it is in views/consoles.ts. See
// docs/plan-v2.md § 3.3 and § 3.4.

/** The shape `tileStateFor`/`orderConsoles` need — a structural subset of
 *  `Console` from core/bridge.ts, so this file does not import anything that
 *  would pull the mock-mode alias in (see src/dev/mock-bridge.ts's note on
 *  why nothing under src/dev imports "../core/bridge", which is the same
 *  reason this file stays independent of it too). */
export interface ConsoleLike {
  id: string;
  label: string;
  verified: boolean;
}

export type TileState = "normal" | "selected" | "unverified";

/** A console's own visual state — never "not-found": that is a fact about
 *  the *selection*, not about any one ficha, and is checked separately with
 *  `selectedConsoleMissing` since the missing console has no ficha of its
 *  own to hold a state. */
export function tileStateFor(console: ConsoleLike, selectedId: string | null): TileState {
  if (console.id === selectedId) return "selected";
  if (!console.verified) return "unverified";
  return "normal";
}

/** True when something is selected that the current list does not contain —
 *  it was picked, and has since been uninstalled or renamed. */
export function selectedConsoleMissing(selectedId: string | null, consoles: ConsoleLike[]): boolean {
  return selectedId != null && !consoles.some((c) => c.id === selectedId);
}

/**
 * Selected first, then anything with a live session, then the verified
 * ones, then the rest — alphabetical within each group. A new array; the
 * input is never mutated.
 */
export function orderConsoles<T extends ConsoleLike>(
  consoles: T[],
  selectedId: string | null,
  liveIds: ReadonlySet<string>,
): T[] {
  const rank = (c: T): number => {
    if (c.id === selectedId) return 0;
    if (liveIds.has(c.id)) return 1;
    if (c.verified) return 2;
    return 3;
  };
  return [...consoles].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

/** Splits into pages of `perPage`. An empty list is one empty page, not
 *  zero pages — callers that render "page 1 of N" never have to special-case
 *  nothing being there yet. */
export function pages<T>(items: T[], perPage: number): T[][] {
  if (items.length === 0) return [[]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += perPage) out.push(items.slice(i, i + perPage));
  return out;
}
