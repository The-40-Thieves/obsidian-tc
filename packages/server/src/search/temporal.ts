// THE-221 Phase 1 — temporal retrieval: a CONDITIONAL fusion stream for queries carrying an
// explicit temporal constraint ("what did we decide about X in June", "the work from 2026-05-05").
// The vault is a dated timeline (daily notes, YYYY-MM-DD decision/research notes), so note-date is
// a high-precision signal — but only when the QUERY asks for it. Detection is precision-first:
// months/years require a temporal preposition (note titles are full of bare "May 2026" /
// "Research 2026" tokens that must NOT route), while ISO dates, early/mid/late-month forms, and
// relative forms ("last week") are unambiguous on their own. Pattern source: Hindsight/TEMPR
// (arXiv 2512.12818) — conditional invocation, range overlap, proximity-to-midpoint ranking.

export interface TemporalRange {
  start: number;
  end: number;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const MONTH_RE = MONTHS.join("|");
const PREP = "(?:in|during|from|since|before|after|around|on)";

const DAY = 86_400_000;

function monthRange(year: number, monthIdx: number): TemporalRange {
  return { start: Date.UTC(year, monthIdx, 1), end: Date.UTC(year, monthIdx + 1, 1) - 1 };
}
function yearRange(year: number): TemporalRange {
  return { start: Date.UTC(year, 0, 1), end: Date.UTC(year + 1, 0, 1) - 1 };
}
function dayRange(y: number, m: number, d: number): TemporalRange {
  const start = Date.UTC(y, m - 1, d);
  return { start, end: start + DAY - 1 };
}

// Apply the preposition's direction to a base range: "before X" = everything up to X's start,
// "since/after X" = X's start (resp. end) through now. Plain "in/during/around/on/from" keep the
// range itself ("from" without "to" reads as "since" — treat like since).
function directed(prep: string, range: TemporalRange, nowMs: number): TemporalRange {
  if (prep === "before") return { start: 0, end: range.start - 1 };
  if (prep === "since" || prep === "from") return { start: range.start, end: nowMs };
  if (prep === "after") return { start: range.end + 1, end: nowMs };
  return range;
}

/** Parse an explicit temporal constraint out of free query text. Returns null when the query has
 *  no unambiguous temporal phrasing — the temporal stream then stays empty and fusion is exactly
 *  the static configuration. `nowMs` is injectable for deterministic tests. */
export function parseTemporalIntent(query: string, nowMs: number): TemporalRange | null {
  const q = query.toLowerCase();
  const now = new Date(nowMs);
  const curYear = now.getUTCFullYear();

  // 1. ISO date — unambiguous with or without a preposition.
  const iso = new RegExp(`(?:(${PREP})\\s+)?\\b(20\\d{2})-(\\d{2})-(\\d{2})\\b`).exec(q);
  if (iso?.[2] && iso[3] && iso[4]) {
    return directed(iso[1] ?? "on", dayRange(+iso[2], +iso[3], +iso[4]), nowMs);
  }

  // 2. early/mid/late <month> [year] — strongly temporal even without a preposition.
  const eml = new RegExp(`\\b(early|mid|late)[ -](${MONTH_RE})(?:\\s+(20\\d{2}))?\\b`).exec(q);
  if (eml?.[1] && eml[2]) {
    const y = eml[3] ? +eml[3] : curYear;
    const m = MONTHS.indexOf(eml[2]);
    const whole = monthRange(y, m);
    const third = Math.floor((whole.end - whole.start) / 3);
    if (eml[1] === "early") return { start: whole.start, end: whole.start + third };
    if (eml[1] === "mid") return { start: whole.start + third, end: whole.end - third };
    return { start: whole.end - third, end: whole.end };
  }

  // 3. <prep> <month> [year] — preposition REQUIRED (titles carry bare month-year tokens).
  const pm = new RegExp(`\\b(${PREP})\\s+(${MONTH_RE})(?:\\s+(20\\d{2}))?\\b`).exec(q);
  if (pm?.[1] && pm[2]) {
    const y = pm[3] ? +pm[3] : curYear;
    return directed(pm[1], monthRange(y, MONTHS.indexOf(pm[2])), nowMs);
  }

  // 4. <prep> <year> — preposition REQUIRED (bare years are ubiquitous in note titles).
  const py = new RegExp(`\\b(${PREP})\\s+(20\\d{2})\\b`).exec(q);
  if (py?.[1] && py[2]) return directed(py[1], yearRange(+py[2]), nowMs);

  // 5. Relative forms. Weeks are rolling 7-day windows (documented); months are calendar.
  if (/\btoday\b/.test(q)) {
    const start = Date.UTC(curYear, now.getUTCMonth(), now.getUTCDate());
    return { start, end: nowMs };
  }
  if (/\byesterday\b/.test(q)) {
    const start = Date.UTC(curYear, now.getUTCMonth(), now.getUTCDate()) - DAY;
    return { start, end: start + DAY - 1 };
  }
  if (/\bthis week\b/.test(q)) return { start: nowMs - 7 * DAY, end: nowMs };
  if (/\blast week\b/.test(q)) return { start: nowMs - 14 * DAY, end: nowMs - 7 * DAY };
  if (/\bthis month\b/.test(q)) {
    return { start: Date.UTC(curYear, now.getUTCMonth(), 1), end: nowMs };
  }
  if (/\blast month\b/.test(q)) {
    return {
      start: Date.UTC(curYear, now.getUTCMonth() - 1, 1),
      end: Date.UTC(curYear, now.getUTCMonth(), 1) - 1,
    };
  }
  if (/\blast year\b/.test(q)) return yearRange(curYear - 1);
  const ago = /\b(\d{1,3})\s+(day|week|month)s?\s+ago\b/.exec(q);
  if (ago?.[1] && ago[2]) {
    const unit = ago[2] === "day" ? DAY : ago[2] === "week" ? 7 * DAY : 30 * DAY;
    const point = nowMs - +ago[1] * unit;
    return { start: point - unit / 2, end: point + unit / 2 };
  }

  return null;
}

/** Note date from the path basename's leading YYYY-MM-DD (daily notes, decision/research notes).
 *  Null when the filename carries no date — such notes never enter the temporal stream. */
export function noteDateMs(path: string): number | null {
  const base = path.split(/[/\\]/).pop() ?? path;
  const m = /^(20\d{2})-(\d{2})-(\d{2})\b/.exec(base);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Number.isFinite(t) ? t : null;
}
