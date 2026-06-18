// Periodic-note path resolution. Pure and heavily unit-tested: given a period and
// an ISO date, resolve the target vault-relative path from the vault's configured
// moment-style format + folder, falling back to Obsidian defaults when config is
// absent. Config sources, in priority order:
//   1. Periodic Notes community plugin — .obsidian/plugins/periodic-notes/data.json
//      ({ daily: { format, folder, template, enabled }, weekly: {...}, ... }).
//   2. Daily Notes core plugin (daily only) — .obsidian/daily-notes.json
//      ({ folder, format, template }).
//   3. Built-in Obsidian defaults (below).
// Weekly numbering is ISO-8601 (Monday-start) and month/day names are English; both
// are documented choices so resolution is deterministic without a live Obsidian.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { err } from "@obsidian-tc/shared";
import { normalizeVaultPath } from "../vault/paths";

export type Period = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

export const DEFAULT_FORMATS: Record<Period, string> = {
  daily: "YYYY-MM-DD",
  weekly: "gggg-[W]ww",
  monthly: "YYYY-MM",
  quarterly: "YYYY-[Q]Q",
  yearly: "YYYY",
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? "th");
}

/** ISO-8601 week number + week-year for a UTC date. */
export function isoWeek(d: Date): { week: number; year: number } {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // move to the Thursday of this week
  const weekYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return { week, year: weekYear };
}

const MOMENT_TOKEN = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|Do|D|dddd|ddd|GGGG|gggg|WW|ww|wo|Q/g;

/**
 * Format a UTC date with a Moment.js-style token string. Supports the tokens
 * Obsidian periodic-note formats use: YYYY YY, MMMM MMM MM M, DD Do D, dddd ddd,
 * gggg/GGGG (ISO week-year), ww/WW (ISO week), wo (ordinal week), Q, and [literal]
 * escapes. Unknown characters pass through verbatim.
 */
export function formatMoment(date: Date, fmt: string): string {
  const { week, year: weekYear } = isoWeek(date);
  const Y = date.getUTCFullYear();
  const Mo = date.getUTCMonth();
  const D = date.getUTCDate();
  const dow = date.getUTCDay();
  return fmt.replace(MOMENT_TOKEN, (match, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    switch (match) {
      case "YYYY":
        return String(Y);
      case "YY":
        return pad(Y % 100);
      case "MMMM":
        return MONTHS[Mo] ?? "";
      case "MMM":
        return (MONTHS[Mo] ?? "").slice(0, 3);
      case "MM":
        return pad(Mo + 1);
      case "M":
        return String(Mo + 1);
      case "DD":
        return pad(D);
      case "Do":
        return ordinal(D);
      case "D":
        return String(D);
      case "dddd":
        return DAYS[dow] ?? "";
      case "ddd":
        return (DAYS[dow] ?? "").slice(0, 3);
      case "GGGG":
      case "gggg":
        return String(weekYear);
      case "WW":
      case "ww":
        return pad(week);
      case "wo":
        return ordinal(week);
      case "Q":
        return String(Math.floor(Mo / 3) + 1);
      default:
        return match;
    }
  });
}

/** Parse an ISO date (yyyy-mm-dd...) to a UTC-midnight Date, or today when absent. */
export function parseDateInput(s?: string): Date {
  if (!s) {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) throw err.invalidInput("date must be an ISO date (yyyy-mm-dd)", { date: s });
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const d = new Date(Date.UTC(y, mo - 1, da));
  if (
    Number.isNaN(d.getTime()) ||
    d.getUTCFullYear() !== y ||
    d.getUTCMonth() !== mo - 1 ||
    d.getUTCDate() !== da
  )
    throw err.invalidInput("date is not a valid calendar date", { date: s });
  return d;
}

/** Format a UTC date back to an ISO yyyy-mm-dd string. */
export function toISODate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export interface PeriodicConfig {
  format: string;
  folder: string;
  template?: string;
}

function readJsonSafe(abs: string): Record<string, unknown> | null {
  if (!existsSync(abs)) return null;
  try {
    const parsed = JSON.parse(readFileSync(abs, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null; // a malformed plugin config falls through to defaults rather than failing resolution
  }
}

/** Resolve the format/folder/template config for a period, with its source. */
export function resolvePeriodicConfig(
  root: string,
  period: Period,
): { config: PeriodicConfig; source: "periodic-notes" | "daily-notes" | "default" } {
  const fromPlugin = readJsonSafe(
    join(root, ".obsidian", "plugins", "periodic-notes", "data.json"),
  );
  const section = fromPlugin?.[period];
  if (section && typeof section === "object") {
    const s = section as Record<string, unknown>;
    return {
      config: {
        format: typeof s.format === "string" && s.format ? s.format : DEFAULT_FORMATS[period],
        folder: typeof s.folder === "string" ? s.folder : "",
        template: typeof s.template === "string" ? s.template : undefined,
      },
      source: "periodic-notes",
    };
  }
  if (period === "daily") {
    const daily = readJsonSafe(join(root, ".obsidian", "daily-notes.json"));
    if (daily) {
      return {
        config: {
          format:
            typeof daily.format === "string" && daily.format ? daily.format : DEFAULT_FORMATS.daily,
          folder: typeof daily.folder === "string" ? daily.folder : "",
          template: typeof daily.template === "string" ? daily.template : undefined,
        },
        source: "daily-notes",
      };
    }
  }
  return { config: { format: DEFAULT_FORMATS[period], folder: "" }, source: "default" };
}

/** Resolve the vault-relative path of the periodic note for a period + date. */
export function resolvePeriodicPath(
  root: string,
  period: Period,
  date: Date,
): { path: string; format: string; folder: string; template?: string; source: string } {
  const { config, source } = resolvePeriodicConfig(root, period);
  const name = formatMoment(date, config.format);
  const folder = config.folder ? normalizeVaultPath(config.folder) : "";
  const path = (folder ? `${folder}/` : "") + `${name}.md`;
  return { path, format: config.format, folder, template: config.template, source };
}
