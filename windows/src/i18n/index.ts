/**
 * The whole i18n surface: t()/tn() to read strings, fmt* to read numbers and
 * dates the same locale-aware way, resolveLocale() to turn the setting
 * ("system" | "en" | "es") into a real Locale. See docs/plan-v2.md § 2.1.
 *
 * No dependency: everything here is Intl, already in the webview. Used by every
 * view, both windows' entry points (main.ts, settings/main.ts) and island/*.
 */

import { en, type En } from "./en";
import { es } from "./es";

/** A language the app ships strings for. */
export type Locale = "en" | "es";
/** The user's language preference: a locale, or "system" to follow the OS. */
export type LocaleSetting = "system" | Locale;

// ── The shape every locale file must have ──────────────────────────────────────

/** Every leaf string in `T` widened to `string`, structure untouched — what
 *  lets es.ts hold different words at the same keys en.ts declares. */
export type DeepStrings<T> = { [K in keyof T]: T[K] extends string ? string : DeepStrings<T[K]> };
/** The shape every dictionary (en, es) must match; en.ts is the source of truth. */
export type Messages = DeepStrings<En>;

/** Dot-path union of every plain-string leaf — what `t()` accepts. */
type StringPaths<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends { one: string; other: string }
    ? never
    : T[K] extends string
      ? `${Prefix}${K}`
      : StringPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Dot-path union of every `{one, other}` leaf — what `tn()` accepts. */
type PluralPaths<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends { one: string; other: string }
    ? `${Prefix}${K}`
    : T[K] extends string
      ? never
      : PluralPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Valid keys for `t()`; a typo is a compile error. */
export type MessageKey = StringPaths<En>;
/** Valid keys for `tn()`. */
export type PluralKey = PluralPaths<En>;

const DICTS: Record<Locale, Messages> = { en, es };

/** Walks a dot path through a dictionary; `undefined` when any segment is missing. */
function lookup(dict: Messages, path: string): unknown {
  return path.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], dict);
}

/** Replaces `{name}` placeholders from `params`; unknown placeholders are left as written. */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
}

/** Module-level on purpose: `t()` is called from everywhere and must not take a locale. */
let currentLocale: Locale = "en";

/** Switches the active locale; views must re-render to pick it up. */
export function setLocale(locale: Locale) {
  currentLocale = locale;
}

/** The active locale. */
export function getLocale(): Locale {
  return currentLocale;
}

/** One string, by its dot path, with `{placeholders}` filled in. Falls back
 *  to English — and says so loudly — rather than let a missing translation
 *  blank out a button in a release build. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const value = lookup(DICTS[currentLocale], key);
  if (typeof value === "string") return interpolate(value, params);

  console.error(`[i18n] missing key "${key}" for locale "${currentLocale}"`);
  const fallback = lookup(DICTS.en, key);
  return typeof fallback === "string" ? interpolate(fallback, params) : key;
}

/** The plural-aware form of `t()` — `{n}` is filled in from `count` even
 *  without it in `params`, since every plural message needs the number. */
export function tn(key: PluralKey, count: number, params?: Record<string, string | number>): string {
  const node = lookup(DICTS[currentLocale], key) as Partial<Record<Intl.LDMLPluralRule, string>> | undefined;
  const category = new Intl.PluralRules(currentLocale).select(count);
  const template = node?.[category] ?? node?.other;

  if (!template) {
    console.error(`[i18n] missing plural key "${key}" for locale "${currentLocale}"`);
    return key;
  }
  return interpolate(template, { n: count, ...params });
}

// ── Formatting ──────────────────────────────────────────────────────────────────

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * KB/MB/GB/TB in binary steps (1024), one decimal below ten and none above —
 * matching the convention `views/system.ts`'s own `size()` already uses, so
 * "9.8 GB" means the same 9.8 × 1024³ bytes everywhere in the app. What
 * changes by locale is only the decimal mark: `Intl.NumberFormat` writes
 * "9,8 GB" in Spanish without this function knowing that itself.
 */
export function fmtBytes(bytes: number, locale: Locale = currentLocale): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return `${new Intl.NumberFormat(locale).format(0)} ${BYTE_UNITS[0]}`;
  }
  const power = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** power;
  const fractionDigits = value < 10 && power > 0 ? 1 : 0;
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
  return `${formatted} ${BYTE_UNITS[power]}`;
}

/** "76 %" in both locales — `Intl` supplies the thin space before the sign. */
export function fmtPercent(value: number, locale: Locale = currentLocale): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(value / 100);
}

/** "3 minutes ago" / "hace 3 minutos" — `Intl.RelativeTimeFormat` writes the
 *  actual words; this only picks which unit reads best for the gap. */
export function fmtRelative(date: number | Date, locale: Locale = currentLocale): string {
  const ms = typeof date === "number" ? date : date.getTime();
  const diffSeconds = (ms - Date.now()) / 1000;
  const abs = Math.abs(diffSeconds);

  let divisor: number;
  let unit: Intl.RelativeTimeFormatUnit;
  if (abs < 60) {
    divisor = 1;
    unit = "second";
  } else if (abs < 3600) {
    divisor = 60;
    unit = "minute";
  } else if (abs < 86400) {
    divisor = 3600;
    unit = "hour";
  } else {
    divisor = 86400;
    unit = "day";
  }

  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(Math.round(diffSeconds / divisor), unit);
}

/** `"system"` reads the first `navigator.languages` entry that is Spanish,
 *  and falls back to English otherwise — there being no third locale to
 *  fall back to yet (docs/plan-v2.md § 8, "fuera de alcance"). */
export function resolveLocale(setting: LocaleSetting): Locale {
  if (setting === "en" || setting === "es") return setting;
  const langs = typeof navigator !== "undefined" ? (navigator.languages ?? [navigator.language]) : [];
  return langs.some((l) => l.toLowerCase().startsWith("es")) ? "es" : "en";
}

export { en, es };
