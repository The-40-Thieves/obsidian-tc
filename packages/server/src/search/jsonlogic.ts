// Compact JSONLogic evaluator (dependency-free) for search_jsonlogic. Implements
// the operators a frontmatter/content filter actually needs; an unknown operator
// is a hard jsonlogic_error rather than a silent false, so callers learn their
// expression used something unsupported. Faithful to jsonlogic.com semantics for
// the implemented subset: a rule object has exactly one operator key; arrays and
// primitives evaluate to themselves; `var` does dotted-path lookup with a default.
import { err } from "@obsidian-tc/shared";

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

export function applyLogic(rule: JsonLogic, data: Record<string, unknown>): unknown {
  if (Array.isArray(rule)) return rule.map((r) => applyLogic(r, data));
  if (!isLogic(rule)) return rule;
  const keys = Object.keys(rule);
  if (keys.length !== 1)
    throw err.jsonlogicError("a logic object must have exactly one operator", { keys });
  const op = keys[0] ?? "";
  const raw = rule[op];
  const args = Array.isArray(raw) ? raw : [raw];
  const ev = (i: number): unknown => applyLogic(args[i], data);

  switch (op) {
    case "var": {
      const p = applyLogic(args[0], data);
      if (p === "" || p === null || p === undefined) return data;
      const v = getPath(data, String(p));
      if (v !== undefined) return v;
      return args.length > 1 ? applyLogic(args[1], data) : null;
    }
    case "missing": {
      const out: unknown[] = [];
      for (const k of args) {
        const key = String(applyLogic(k, data));
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
    default:
      throw err.jsonlogicError(`unsupported JSONLogic operator: ${op}`, { op });
  }
}

export function evaluatesTruthy(rule: JsonLogic, data: Record<string, unknown>): boolean {
  return truthy(applyLogic(rule, data));
}
