// THE-281 — a deliberate SUBSET of the Obsidian Bases expression DSL (filters + formulas).
// Tokenizer + Pratt parser + evaluator over a per-note context. The honesty contract from
// THE-284 carries over: any construct OUTSIDE the subset (lambdas, bracket access, unknown
// methods/functions, mixed DSL/JSONLogic trees) throws the typed `unsupported_base_filter`
// with the offending expression — never a silent match-all or a silent null.
//
// Subset: literals ("str" 'str' numbers true false null [lists]); property namespaces
// file.name/path/folder/ext/tags/links + file.hasTag()/inFolder()/hasLink(), note.<prop>
// (frontmatter), formula.<name> (previously computed columns), bare identifier = note.<prop>;
// operators || && ! == != > >= < <= + - * / % and parentheses; string methods contains/
// startsWith/endsWith/isEmpty/lower/upper/trim/length; list methods contains/length/isEmpty/
// join; globals if/date/now/today/min/max/list/number; Date +/- duration strings ('30m','1d',
// '2w'...). Filter combinators: bare string, or {and|or|not: [...]} recursively over strings.
import { err } from "@the-40-thieves/obsidian-tc-shared";

export interface BasesNoteCtx {
  path: string;
  frontmatter: Record<string, unknown>;
  /** Normalized tags, no leading '#'. */
  tags: string[];
  /** Outgoing link targets, raw as written. */
  links: string[];
  /** Previously computed formula columns (formula.<name>). */
  formulas?: Record<string, unknown>;
}

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "punc"; v: string }
  | { t: "op"; v: string }
  | { t: "eof" };

type Ast =
  | { k: "lit"; v: unknown }
  | { k: "list"; items: Ast[] }
  | { k: "id"; name: string }
  | { k: "member"; obj: Ast; name: string }
  | { k: "call"; callee: Ast; args: Ast[] }
  | { k: "un"; op: string; e: Ast }
  | { k: "bin"; op: string; l: Ast; r: Ast };

function unsup(msg: string, expression: string): never {
  throw err.unsupportedBaseFilter(`${msg} (Bases DSL subset, THE-281)`, { expression });
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const twoOps = ["||", "&&", "==", "!=", ">=", "<="];
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let out = "";
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\" && i + 1 < src.length) {
          out += src[i + 1];
          i += 2;
        } else {
          out += src[i];
          i++;
        }
      }
      if (i >= src.length) unsup("unterminated string", src);
      i++;
      toks.push({ t: "str", v: out });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i)) as RegExpExecArray;
      toks.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i)) as RegExpExecArray;
      // true/false/null resolve to literals in the parser; everything else is an identifier.
      toks.push({ t: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (twoOps.includes(two)) {
      toks.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("><+-*/%!".includes(c)) {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    if ("()[],.".includes(c)) {
      toks.push({ t: "punc", v: c });
      i++;
      continue;
    }
    unsup(`unexpected character '${c}'`, src);
  }
  toks.push({ t: "eof" });
  return toks;
}

const BIN_PREC: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  ">": 4,
  ">=": 4,
  "<": 4,
  "<=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

const parseCache = new Map<string, Ast>();

export function parseBasesExpr(src: string): Ast {
  const cached = parseCache.get(src);
  if (cached) return cached;
  const toks = tokenize(src);
  let pos = 0;
  const peek = (): Tok => toks[pos] as Tok;
  const next = (): Tok => toks[pos++] as Tok;
  const expectPunc = (v: string): void => {
    const t = next();
    if (t.t !== "punc" || t.v !== v) unsup(`expected '${v}'`, src);
  };
  function parsePrimary(): Ast {
    const t = next();
    if (t.t === "num") return { k: "lit", v: t.v };
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "id") {
      if (t.v === "true") return { k: "lit", v: true };
      if (t.v === "false") return { k: "lit", v: false };
      if (t.v === "null") return { k: "lit", v: null };
      return { k: "id", name: t.v };
    }
    if (t.t === "op" && t.v === "!") return { k: "un", op: "!", e: parseUnary() };
    if (t.t === "op" && t.v === "-") return { k: "un", op: "-", e: parseUnary() };
    if (t.t === "punc" && t.v === "(") {
      const e = parseExpr(0);
      expectPunc(")");
      return e;
    }
    if (t.t === "punc" && t.v === "[") {
      const items: Ast[] = [];
      if (!(peek().t === "punc" && (peek() as { v: string }).v === "]")) {
        for (;;) {
          items.push(parseExpr(0));
          const n = next();
          if (n.t === "punc" && n.v === "]") break;
          if (!(n.t === "punc" && n.v === ",")) unsup("expected ',' or ']'", src);
        }
      } else next();
      return { k: "list", items };
    }
    unsup("unexpected token", src);
  }
  function parseUnary(): Ast {
    return parsePostfix(parsePrimary());
  }
  function parsePostfix(e: Ast): Ast {
    for (;;) {
      const t = peek();
      if (t.t === "punc" && t.v === ".") {
        next();
        const id = next();
        if (id.t !== "id") unsup("expected a property/method name after '.'", src);
        e = { k: "member", obj: e, name: id.v };
        continue;
      }
      if (t.t === "punc" && t.v === "(") {
        next();
        const args: Ast[] = [];
        if (!(peek().t === "punc" && (peek() as { v: string }).v === ")")) {
          for (;;) {
            args.push(parseExpr(0));
            const n = next();
            if (n.t === "punc" && n.v === ")") break;
            if (!(n.t === "punc" && n.v === ",")) unsup("expected ',' or ')'", src);
          }
        } else next();
        e = { k: "call", callee: e, args };
        continue;
      }
      if (t.t === "punc" && t.v === "[") unsup("bracket access is not in the subset", src);
      return e;
    }
  }
  function parseExpr(minPrec: number): Ast {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t.t !== "op") return left;
      const prec = BIN_PREC[t.v];
      if (prec === undefined || prec < minPrec) return left;
      next();
      const right = parseExpr(prec + 1);
      left = { k: "bin", op: t.v, l: left, r: right };
    }
  }
  const ast = parseExpr(0);
  if (peek().t !== "eof") unsup("unexpected trailing tokens", src);
  parseCache.set(src, ast);
  return ast;
}

// ---- evaluation -------------------------------------------------------------

const DUR_RE = /^(\d+)\s*(s|m|h|d|w|M|y)$/;
function parseDuration(s: string): number | null {
  const m = DUR_RE.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] as string;
  const MS: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    M: 2_592_000_000,
    y: 31_536_000_000,
  };
  return n * (MS[unit] ?? 0);
}

export function basesTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function scalar(v: unknown): unknown {
  return v instanceof Date ? v.getTime() : v;
}

function looseEq(a: unknown, b: unknown): boolean {
  const x = scalar(a);
  const y = scalar(b);
  if (x === null || x === undefined) return y === null || y === undefined;
  if (typeof x === "number" || typeof y === "number") return Number(x) === Number(y);
  return String(x) === String(y);
}

function baseNameNoExt(p: string): string {
  const b = p.split("/").pop() ?? p;
  return b.replace(/\.md$/i, "").toLowerCase();
}

const FILE_SENTINEL = Symbol("file");

// Every method name in the subset. A missing property yields null for a KNOWN method; an
// unknown method refuses even on null receivers — otherwise unsupported constructs would
// silently pass on notes lacking the property (honesty contract).
const KNOWN_METHODS = new Set([
  "contains",
  "startsWith",
  "endsWith",
  "isEmpty",
  "lower",
  "upper",
  "trim",
  "length",
  "join",
  "hasTag",
  "inFolder",
  "hasLink",
]);

function evalAst(a: Ast, ctx: BasesNoteCtx, src: string): unknown {
  switch (a.k) {
    case "lit":
      return a.v;
    case "list":
      return a.items.map((e) => evalAst(e, ctx, src));
    case "id": {
      if (a.name === "file") return FILE_SENTINEL;
      if (a.name === "note" || a.name === "formula")
        unsup(`'${a.name}' must be followed by a property`, src);
      return ctx.frontmatter[a.name] ?? null; // bare identifier = note.<prop>
    }
    case "member": {
      if (a.obj.k === "id" && a.obj.name === "note") return ctx.frontmatter[a.name] ?? null;
      if (a.obj.k === "id" && a.obj.name === "formula") return ctx.formulas?.[a.name] ?? null;
      if (a.obj.k === "id" && a.obj.name === "file") {
        switch (a.name) {
          case "name":
            return (ctx.path.split("/").pop() ?? ctx.path).replace(/\.md$/i, "");
          case "path":
            return ctx.path;
          case "folder": {
            const i = ctx.path.lastIndexOf("/");
            return i < 0 ? "" : ctx.path.slice(0, i);
          }
          case "ext":
            return "md";
          case "tags":
            return ctx.tags;
          case "links":
            return ctx.links;
          default:
            unsup(`file.${a.name} is not in the subset`, src);
        }
      }
      unsup(`property access '.${a.name}' on a computed value is not in the subset`, src);
      break;
    }
    case "un": {
      const v = evalAst(a.e, ctx, src);
      if (a.op === "!") return !basesTruthy(v);
      return -Number(scalar(v));
    }
    case "bin": {
      if (a.op === "||") {
        const l = evalAst(a.l, ctx, src);
        return basesTruthy(l) ? l : evalAst(a.r, ctx, src);
      }
      if (a.op === "&&") {
        const l = evalAst(a.l, ctx, src);
        return basesTruthy(l) ? evalAst(a.r, ctx, src) : l;
      }
      const l = evalAst(a.l, ctx, src);
      const r = evalAst(a.r, ctx, src);
      switch (a.op) {
        case "==":
          return looseEq(l, r);
        case "!=":
          return !looseEq(l, r);
        case ">":
          return Number(scalar(l)) > Number(scalar(r));
        case ">=":
          return Number(scalar(l)) >= Number(scalar(r));
        case "<":
          return Number(scalar(l)) < Number(scalar(r));
        case "<=":
          return Number(scalar(l)) <= Number(scalar(r));
        case "+": {
          if (l instanceof Date && typeof r === "string") {
            const d = parseDuration(r);
            if (d === null) unsup(`'${r}' is not a duration`, src);
            return new Date(l.getTime() + d);
          }
          if (typeof l === "string" || typeof r === "string")
            return String(scalar(l) ?? "") + String(scalar(r) ?? "");
          return Number(scalar(l)) + Number(scalar(r));
        }
        case "-": {
          if (l instanceof Date && typeof r === "string") {
            const d = parseDuration(r);
            if (d === null) unsup(`'${r}' is not a duration`, src);
            return new Date(l.getTime() - d);
          }
          return Number(scalar(l)) - Number(scalar(r));
        }
        case "*":
          return Number(scalar(l)) * Number(scalar(r));
        case "/":
          return Number(scalar(l)) / Number(scalar(r));
        case "%":
          return Number(scalar(l)) % Number(scalar(r));
        default:
          unsup(`operator '${a.op}' is not in the subset`, src);
      }
      break;
    }
    case "call": {
      const callee = a.callee;
      // global functions
      if (callee.k === "id") {
        const args = (): unknown[] => a.args.map((x) => evalAst(x, ctx, src));
        switch (callee.name) {
          case "if": {
            if (a.args.length < 2 || a.args.length > 3) unsup("if(cond, then, else?)", src);
            const c = evalAst(a.args[0] as Ast, ctx, src);
            if (basesTruthy(c)) return evalAst(a.args[1] as Ast, ctx, src);
            return a.args[2] ? evalAst(a.args[2], ctx, src) : null;
          }
          case "date": {
            const s = String(evalAst(a.args[0] as Ast, ctx, src) ?? "");
            const t = Date.parse(s);
            if (Number.isNaN(t)) unsup(`date('${s}') is not parseable`, src);
            return new Date(t);
          }
          case "now":
            return new Date();
          case "today": {
            const d = new Date();
            d.setHours(0, 0, 0, 0);
            return d;
          }
          case "min":
            return Math.min(...args().map((x) => Number(scalar(x))));
          case "max":
            return Math.max(...args().map((x) => Number(scalar(x))));
          case "list":
            return args();
          case "number":
            return Number(scalar(evalAst(a.args[0] as Ast, ctx, src)));
          default:
            unsup(`function ${callee.name}() is not in the subset`, src);
        }
      }
      // method calls
      if (callee.k === "member") {
        const recv = evalAst(callee.obj, ctx, src);
        const args = a.args.map((x) => evalAst(x, ctx, src));
        const m = callee.name;
        if (recv === FILE_SENTINEL) {
          switch (m) {
            case "hasTag": {
              const want = args.map((x) => String(x ?? "").replace(/^#/, ""));
              return want.some((w) => ctx.tags.includes(w));
            }
            case "inFolder": {
              const f = String(args[0] ?? "").replace(/\/+$/, "");
              return f === "" ? true : ctx.path === f || ctx.path.startsWith(`${f}/`);
            }
            case "hasLink": {
              const want = String(args[0] ?? "");
              const wantBase = baseNameNoExt(want);
              return ctx.links.some((l) => l === want || baseNameNoExt(l) === wantBase);
            }
            default:
              unsup(`file.${m}() is not in the subset`, src);
          }
        }
        if (typeof recv === "string") {
          switch (m) {
            case "contains":
              return recv.includes(String(args[0] ?? ""));
            case "startsWith":
              return recv.startsWith(String(args[0] ?? ""));
            case "endsWith":
              return recv.endsWith(String(args[0] ?? ""));
            case "isEmpty":
              return recv.length === 0;
            case "lower":
              return recv.toLowerCase();
            case "upper":
              return recv.toUpperCase();
            case "trim":
              return recv.trim();
            case "length":
              return recv.length;
            default:
              unsup(`string method .${m}() is not in the subset`, src);
          }
        }
        if (Array.isArray(recv)) {
          switch (m) {
            case "contains":
              return recv.some((x) => looseEq(x, args[0]));
            case "length":
              return recv.length;
            case "isEmpty":
              return recv.length === 0;
            case "join":
              return recv.map((x) => String(scalar(x) ?? "")).join(String(args[0] ?? ","));
            default:
              unsup(`list method .${m}() is not in the subset`, src);
          }
        }
        if (recv === null || recv === undefined) {
          if (KNOWN_METHODS.has(m)) return null; // missing property -> null, not an error
          unsup(`method .${m}() is not in the subset`, src);
        }
        unsup(`method .${m}() on a ${typeof recv} is not in the subset`, src);
      }
      unsup("computed call targets are not in the subset", src);
      break;
    }
  }
  unsup("unreachable expression", src);
}

/** Evaluate a parsed (or source) expression against a note context. */
export function evaluateBasesExpr(expr: Ast | string, ctx: BasesNoteCtx): unknown {
  const src = typeof expr === "string" ? expr : "<parsed>";
  const ast = typeof expr === "string" ? parseBasesExpr(expr) : expr;
  const v = evalAst(ast, ctx, src);
  return v instanceof Date ? v.toISOString() : v;
}

export type FilterClass = "absent" | "dsl" | "jsonlogic" | "mixed";

/**
 * Classify a filter tree. Pure strings / combinators-of-strings are the Bases DSL; objects with
 * no string leaves under and/or/not are obsidian-tc's JSONLogic; MIXED trees are refused by the
 * caller (evaluating half a tree in each engine risks silent mis-evaluation — THE-284 honesty).
 */
export function classifyBaseFilter(x: unknown): FilterClass {
  if (x === undefined || x === null) return "absent";
  if (typeof x === "string") return "dsl";
  if (typeof x === "object" && !Array.isArray(x)) {
    const keys = Object.keys(x as Record<string, unknown>);
    const k = keys[0];
    if (keys.length === 1 && (k === "and" || k === "or" || k === "not")) {
      const arr = (x as Record<string, unknown>)[k as string];
      if (Array.isArray(arr)) {
        const parts = arr.map(classifyBaseFilter);
        if (parts.every((p) => p === "dsl")) return "dsl";
        if (parts.every((p) => p === "jsonlogic")) return "jsonlogic";
        return "mixed";
      }
    }
    return "jsonlogic";
  }
  return "jsonlogic";
}

/** Evaluate a pure-DSL filter tree (string, or and/or/not over strings) for one note. */
export function evaluateBasesFilter(node: unknown, ctx: BasesNoteCtx): boolean {
  if (typeof node === "string") return basesTruthy(evalAst(parseBasesExpr(node), ctx, node));
  if (typeof node === "object" && node !== null && !Array.isArray(node)) {
    const o = node as Record<string, unknown>;
    if (Array.isArray(o.and)) return o.and.every((e) => evaluateBasesFilter(e, ctx));
    if (Array.isArray(o.or)) return o.or.some((e) => evaluateBasesFilter(e, ctx));
    if (Array.isArray(o.not)) return !o.not.some((e) => evaluateBasesFilter(e, ctx));
  }
  unsup("filter node is not a string or and/or/not combinator", JSON.stringify(node).slice(0, 200));
}
