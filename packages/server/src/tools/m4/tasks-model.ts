// Minimal Tasks-plugin task-line model. Parses a Markdown checkbox line into typed
// fields and serializes fields back to a canonical line (emoji metadata emitted in
// a fixed order — the Tasks plugin accepts any order). Filesystem-only: list_tasks
// and update_task need no plugin. The Tasks *DSL filter* runs through the bridge.

export type TaskStatus = "todo" | "done" | "cancelled" | "in_progress" | "scheduled";
export type TaskPriority = "highest" | "high" | "medium" | "low" | "lowest";

const STATUS_BY_CHAR: Record<string, TaskStatus> = {
  " ": "todo",
  x: "done",
  X: "done",
  "/": "in_progress",
  "-": "cancelled",
  ">": "scheduled",
};
const CHAR_BY_STATUS: Record<TaskStatus, string> = {
  todo: " ",
  done: "x",
  in_progress: "/",
  cancelled: "-",
  scheduled: ">",
};

const PRIO_EMOJI: Record<TaskPriority, string> = {
  highest: "🔺",
  high: "⏫",
  medium: "🔼",
  low: "🔽",
  lowest: "⏬",
};

const DUE = "📅";
const SCHED = "⏳";
const START = "🛫";
const DONE = "✅";
const RECUR = "🔁";
// Lookahead boundary: any field-leading emoji, a tag, or end-of-line.
const STOP = `(?=\\s*(?:${DUE}|${SCHED}|${START}|${DONE}|${RECUR}|🔺|⏫|🔼|🔽|⏬|#|$))`;
const DATE = "(\\d{4}-\\d{2}-\\d{2})";
const TASK_RE = /^(\s*)([-*+]|\d+\.)\s+\[(.)\]\s+(.*)$/;
const TAG_RE = /#[\w/-]+/g;

export interface TaskFields {
  indent: string;
  marker: string;
  status: TaskStatus;
  /** Visible text, tags retained inline; date/priority/recurrence metadata stripped. */
  description: string;
  due?: string;
  scheduled?: string;
  start?: string;
  done?: string;
  priority?: TaskPriority;
  recur?: string;
  tags: string[];
}

/** Parse one line into task fields, or null if it is not a recognized task line. */
export function parseTaskLine(line: string): TaskFields | null {
  const m = TASK_RE.exec(line);
  if (!m) return null;
  const indent = m[1] ?? "";
  const marker = m[2] ?? "-";
  const status = STATUS_BY_CHAR[m[3] ?? " "];
  if (!status) return null;
  let rest = m[4] ?? "";

  const take = (re: RegExp): string | undefined => {
    const mm = re.exec(rest);
    if (!mm) return undefined;
    rest = rest.replace(mm[0], " ");
    return mm[1];
  };

  const due = take(new RegExp(`${DUE}\\s*${DATE}`, "u"));
  const scheduled = take(new RegExp(`${SCHED}\\s*${DATE}`, "u"));
  const start = take(new RegExp(`${START}\\s*${DATE}`, "u"));
  const done = take(new RegExp(`${DONE}\\s*${DATE}`, "u"));
  const recur = take(new RegExp(`${RECUR}\\s*(.+?)${STOP}`, "u"))?.trim();

  let priority: TaskPriority | undefined;
  for (const [prio, emoji] of Object.entries(PRIO_EMOJI)) {
    if (rest.includes(emoji)) {
      priority = prio as TaskPriority;
      rest = rest.replace(emoji, " ");
      break;
    }
  }

  const description = rest.replace(/\s+/g, " ").trim();
  const tags = [...description.matchAll(TAG_RE)].map((t) => t[0]);

  return {
    indent,
    marker,
    status,
    description,
    tags,
    ...(due ? { due } : {}),
    ...(scheduled ? { scheduled } : {}),
    ...(start ? { start } : {}),
    ...(done ? { done } : {}),
    ...(priority ? { priority } : {}),
    ...(recur ? { recur } : {}),
  };
}

/** Serialize fields back to a canonical task line (metadata in fixed order). */
export function serializeTask(f: TaskFields): string {
  const parts = [f.description.trim()];
  if (f.priority) parts.push(PRIO_EMOJI[f.priority]);
  if (f.recur) parts.push(`${RECUR} ${f.recur.trim()}`);
  if (f.start) parts.push(`${START} ${f.start}`);
  if (f.scheduled) parts.push(`${SCHED} ${f.scheduled}`);
  if (f.due) parts.push(`${DUE} ${f.due}`);
  if (f.done) parts.push(`${DONE} ${f.done}`);
  return `${f.indent}${f.marker} [${CHAR_BY_STATUS[f.status]}] ${parts.filter(Boolean).join(" ")}`;
}

export interface TaskSet {
  status?: TaskStatus;
  description?: string;
  due?: string;
  scheduled?: string;
  start?: string;
  done?: string;
  priority?: TaskPriority;
  recur?: string;
  add_tags?: string[];
  remove_tags?: string[];
}

const asTag = (t: string): string => (t.startsWith("#") ? t : `#${t}`);

/** Apply a `set` mutation, returning new fields. Empty-string date/priority clears it. */
export function applyTaskSet(f: TaskFields, set: TaskSet): TaskFields {
  const next: TaskFields = { ...f };
  if (set.status) next.status = set.status;
  if (set.description !== undefined) next.description = set.description;
  if (set.due !== undefined) next.due = set.due || undefined;
  if (set.scheduled !== undefined) next.scheduled = set.scheduled || undefined;
  if (set.start !== undefined) next.start = set.start || undefined;
  if (set.done !== undefined) next.done = set.done || undefined;
  if (set.priority !== undefined) next.priority = set.priority || undefined;
  if (set.recur !== undefined) next.recur = set.recur || undefined;

  for (const t of set.add_tags ?? []) {
    const tag = asTag(t);
    if (!next.description.includes(tag)) next.description = `${next.description} ${tag}`.trim();
  }
  for (const t of set.remove_tags ?? []) {
    next.description = next.description.replace(asTag(t), "").replace(/\s+/g, " ").trim();
  }
  next.tags = [...next.description.matchAll(TAG_RE)].map((t) => t[0]);
  return next;
}

/** Whole days elapsed between an ISO date (YYYY-MM-DD) and `nowMs`. */
export function daysSince(isoDate: string, nowMs: number): number {
  const then = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(then)) return 0;
  return Math.floor((nowMs - then) / 86_400_000);
}
