/**
 * ISO 8601 week number (and its week-year) for a date, computed in UTC.
 *
 * This lived in two files — formats/periodic.ts and plane/jobs/synthesis.ts — as two DIFFERENT
 * implementations of the same standard (one via the Thursday-of-week rule, one via a day-of-year
 * formula). They were verified to agree on every day from 2020 through 2030, including all year
 * boundaries, so this is a behavior-preserving consolidation. It also removes the risk that a future edit
 * to one copy silently disagrees with the other on a boundary week.
 */
export interface IsoWeek {
  year: number;
  week: number;
}

export function isoWeek(d: Date): IsoWeek {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // move to the Thursday of this week
  const weekYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return { year: weekYear, week };
}
