// Compact JSONLogic evaluator (dependency-free) for search_jsonlogic. Implements
// the operators a frontmatter/content filter actually needs; an unknown operator
// is a hard jsonlogic_error rather than a silent false, so callers learn their
// expression used something unsupported. Faithful to jsonlogic.com semantics for
// the implemented subset: a rule object has exactly one operator key; arrays and
// primitives evaluate to themselves; `var` does dotted-path lookup with a default.
import { err } from "@the-40-thieves/obsidian-tc-shared";

export type JsonLogic = unknown;

function isLogic(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function getPath(data: unknown, path: string): unknown {
  if (path === "") return data;
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

function num(v: unknown): number {
  return typeof v === "boolean" ? (v ? 1 : 0) : Number(v);
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (
    typeof a === "number" ||
    typeof b === "number" ||
    typeof a === "boolean" ||
    typeof b === "boolean"
  )
    return num(a) === num(b);
  return String(a) === String(b);
}

/** Mutable evaluation budget (THE-293). Decremented on EVERY applyLogic entry — literals,
 *  array elements, and logic nodes alike — so wide flat expressions (a 100k-arg "and"/"cat",
 *  a huge "in" haystack) are bounded, not just deeply nested ones (the depth cap). */
export interface OpBudget {
  ops: number;
}

export function applyLogic(
  rule: JsonLogic,
  data: Record<string, unknown>,
  budget?: OpBudget,
): unknown {
  if (budget && --budget.ops < 0)
    throw err.jsonlogicError("logic expression exceeded the operation budget", {
      max_ops: MAX_LOGIC_OPS,
    });
  if (Array.isArray(rule)) return rule.map((r) => applyLogic(r, data, budget));
  if (!isLogic(rule)) return rule;
  const keys = Object.keys(rule);
  if (keys.length !== 1)
    throw err.jsonlogicError("a logic object must have exactly one operator", { keys });
  const op = keys[0] ?? "";
  const raw = rule[op];
  const args = Array.isArray(raw) ? raw : [raw];
  const ev = (i: number): unknown => applyLogic(args[i], data, budget);

  switch (op) {
    case "var": {
      const p = applyLogic(args[0], data, budget);
      if (p === "" || p === null || p === undefined) return data;
      const v = getPath(data, String(p));
      if (v !== undefined) return v;
      return args.length > 1 ? applyLogic(args[1], data, budget) : null;
    }
    case "missing": {
      const out: unknown[] = [];
      for (const k of args) {
        const key = String(applyLogic(k, data, budget));
        if (getPath(data, key) === undefined) out.push(key);
      }
      return out;
    }
    case "==":
      return looseEq(ev(0), ev(1));
    case "!=":
      return !looseEq(ev(0), ev(1));
    case "===":
      return ev(0) === ev(1);
    case "!==":
      return ev(0) !== ev(1);
    case ">":
      return num(ev(0)) > num(ev(1));
    case ">=":
      return num(ev(0)) >= num(ev(1));
    case "<":
      return num(ev(0)) < num(ev(1));
    case "<=":
      return num(ev(0)) <= num(ev(1));
    case "!":
      return !truthy(ev(0));
    case "!!":
      return truthy(ev(0));
    case "and": {
      let result: unknown = true;
      for (let i = 0; i < args.length; i++) {
        result = ev(i);
        if (!truthy(result)) return result;
      }
      return result;
    }
    case "or": {
      let result: unknown = false;
      for (let i = 0; i < args.length; i++) {
        result = ev(i);
        if (truthy(result)) return result;
      }
      return result;
    }
    case "in": {
      const needle = ev(0);
      const hay = ev(1);
      if (typeof hay === "string") return typeof needle === "string" && hay.includes(needle);
      if (Array.isArray(hay)) return hay.includes(needle);
      return false;
    }
    case "+": {
      let s = 0;
      for (let i = 0; i < args.length; i++) s += num(ev(i));
      return s;
    }
    case "*": {
      let s = 1;
      for (let i = 0; i < args.length; i++) s *= num(ev(i));
      return s;
    }
    case "-":
      return args.length === 1 ? -num(ev(0)) : num(ev(0)) - num(ev(1));
    case "/":
      return num(ev(0)) / num(ev(1));
    case "%":
      return num(ev(0)) % num(ev(1));
    case "cat": {
      let s = "";
      for (let i = 0; i < args.length; i++) s += String(ev(i) ?? "");
      return s;
    }
    case "if":
    case "?:": {
      // {"if":[c1,v1,c2,v2,...,else]} — chained if/elseif/else; an odd trailing arg is the else.
      for (let i = 0; i + 1 < args.length; i += 2) if (truthy(ev(i))) return ev(i + 1);
      return args.length % 2 === 1 ? ev(args.length - 1) : null;
    }
    case "min":
      return Math.min(...args.map((_, i) => num(ev(i))));
    case "max":
      return Math.max(...args.map((_, i) => num(ev(i))));
    case "substr": {
      const str = String(ev(0) ?? "");
      const start = num(ev(1));
      const from = start < 0 ? Math.max(str.length + start, 0) : start;
      if (args.length <= 2) return str.slice(from);
      const len = num(ev(2));
      return len < 0 ? str.slice(from, str.length + len) : str.slice(from, from + len);
    }
    case "merge": {
      const out: unknown[] = [];
      for (let i = 0; i < args.length; i++) {
        const x = ev(i);
        if (Array.isArray(x)) out.push(...x);
        else out.push(x);
      }
      return out;
    }
    case "missing_some": {
      const min = num(ev(0));
      const keys = ev(1);
      if (!Array.isArray(keys)) return [];
      const missing = keys.filter((k) => getPath(data, String(k)) === undefined);
      return keys.length - missing.length >= min ? [] : missing;
    }
    // Array iteration: the second arg is a sub-rule run with each element as its data.
    case "map": {
      const arr = ev(0);
      return Array.isArray(arr)
        ? arr.map((it) => applyLogic(args[1], it as Record<string, unknown>, budget))
        : [];
    }
    case "filter": {
      const arr = ev(0);
      return Array.isArray(arr)
        ? arr.filter((it) => truthy(applyLogic(args[1], it as Record<string, unknown>, budget)))
        : [];
    }
    case "reduce": {
      const arr = ev(0);
      if (!Array.isArray(arr)) return ev(2);
      let acc = ev(2);
      for (const it of arr) acc = applyLogic(args[1], { current: it, accumulator: acc }, budget);
      return acc;
    }
    case "all": {
      const arr = ev(0);
      if (!Array.isArray(arr) || arr.length === 0) return false;
      return arr.every((it) => truthy(applyLogic(args[1], it as Record<string, unknown>, budget)));
    }
    case "some": {
      const arr = ev(0);
      return Array.isArray(arr)
        ? arr.some((it) => truthy(applyLogic(args[1], it as Record<string, unknown>, budget)))
        : false;
    }
    case "none": {
      const arr = ev(0);
      return Array.isArray(arr)
        ? !arr.some((it) => truthy(applyLogic(args[1], it as Record<string, unknown>, budget)))
        : true;
    }
    default:
      throw err.jsonlogicError(`unsupported JSONLogic operator: ${op}`, { op });
  }
}

const MAX_LOGIC_DEPTH = 64;
// THE-293: per-evaluation op budget seeded by evaluatesTruthy (total work is bounded by
// MAX_LOGIC_OPS x note-count in search_jsonlogic). Mirrors the un-configurable depth cap.
const MAX_LOGIC_OPS = 10_000;

/** Bounded depth walk (cannot overflow itself) used to reject over-nested expressions
 *  before applyLogic would blow the call stack (audit). */
function logicDepth(rule: unknown, d: number): number {
  if (d > MAX_LOGIC_DEPTH) return d;
  if (Array.isArray(rule)) {
    let mx = d;
    for (const r of rule) mx = Math.max(mx, logicDepth(r, d + 1));
    return mx;
  }
  if (rule && typeof rule === "object") {
    let mx = d;
    for (const r of Object.values(rule)) mx = Math.max(mx, logicDepth(r, d + 1));
    return mx;
  }
  return d;
}

export function evaluatesTruthy(rule: JsonLogic, data: Record<string, unknown>): boolean {
  if (logicDepth(rule, 0) > MAX_LOGIC_DEPTH)
    throw err.jsonlogicError("logic expression nested too deeply", { max_depth: MAX_LOGIC_DEPTH });
  return truthy(applyLogic(rule, data, { ops: MAX_LOGIC_OPS }));
}
