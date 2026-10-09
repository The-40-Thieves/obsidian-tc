#!/usr/bin/env node
/**
 * ACL canonical-identity gate (AST data-flow scan).
 *
 * A symlinked vault folder gives one file two names: the DISPLAY name a walk or a stored row shows
 * (`wiki/x.md`) and the CANONICAL target the ACL must judge (`private/x.md`). Authorizing the display
 * name shows a caller a file `read_note` refuses. Three PRs closed instances of this class: walker
 * enumeration (judge `WalkEntry.aclRel`, not `relPath`), bridge rows (`readableResolved`) and
 * DB-served rows (`readableStoredRow` on the stored `acl_path`). The guard that followed was a source
 * scan that counted files and grepped `readableRel(...relPath`; it missed every shape where the
 * display path reaches the predicate by any road but the literal call text.
 *
 * This gate follows the value instead. It parses every `packages/server/src` file (oxc-parser; the
 * TypeScript 7 compiler has no JS API, which check-boundaries.mjs documents, and ast-grep matches
 * syntax, not flow) and tracks one taint through lexical scopes:
 *
 *   D  a display path:  `<x>.relPath`, a `{ relPath }` destructure, or `<row>.path` / `{ path }` of a
 *      database ROW (R: the result of `.all()/.get()/.iterate()` on a `prepare()/query()` statement,
 *      or of a function that returns one).
 *   P  a parameter of the function being analysed, so a helper that forwards its parameter to a
 *      lexical ACL predicate is itself a SINK for its callers (a wrapper), however many layers deep,
 *      whether it is a local const, a function declaration, an imported function, an object-property
 *      callback (`isReadable: (p) => readableRel(...)`) or a class method.
 *
 * D flows through aliases, destructuring, for-of, array callbacks (`filter/map/find/...`), template
 * literals, string methods, ternaries and unknown calls; it is dropped by a member read of anything
 * but those two names (`.aclRel`, `.abs`) and by calling a `storedAclPathOf(...)` result. A violation
 * is D reaching a lexical decider: `readableRel` / `readableByFolder` / `pathScopesSatisfied`
 * (path argument), `isDefaultDenied`, `.matchedPathGlob` / `.scopesForPath` / `.immutableGlobFor`, or
 * a wrapper that forwards to one. The sanctioned roads are untouched: `readableEntry` (typed
 * `aclRel`), `readableStoredRow`, `readableResolved`, `callerCanReadVaultPath`, `enforcePathAcl`.
 *
 * Known limits, stated so nobody mistakes the gate for a proof: row-ness does not survive an
 * unannotated helper in another file's return type, a path stored in an object field and read back
 * later is invisible, and the wrapper registry is keyed by name (imports for functions, property name
 * for callbacks and methods), so two unrelated callbacks sharing a property name share a verdict.
 * Those fail toward a false POSITIVE, which the reviewed ALLOWLIST below resolves with a reason.
 *
 * Floors (a scan that finds nothing is not a pass): enough files, enough direct ACL call sites,
 * wrappers, and DB-row sources; and every ALLOWLIST entry must still match a real finding, so a stale
 * exemption cannot sit there covering a later regression.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseSync } from "oxc-parser";

const SOURCE_GLOBS = ["packages/server/src/*.ts", "packages/server/src/**/*.ts"];
const MIN_FILES = 300;
const MIN_DIRECT_SINK_CALLS = 40;
const MIN_WRAPPERS = 5;
const MIN_ROW_SOURCES = 5;

/** Lexical ACL deciders: callee name -> indexes of the argument that is judged as a path. */
export const SINKS = new Map([
  ["readableRel", [1]],
  ["readableByFolder", [1]],
  ["pathScopesSatisfied", [1]],
  ["isDefaultDenied", [0]],
  ["matchedPathGlob", [1]],
  ["scopesForPath", [0]],
  ["immutableGlobFor", [0]],
]);

/**
 * Reviewed exemptions: a lexical decision on a display-shaped value that is nonetheless already
 * canonical. `file`, enclosing function, sink and the exact number of sites (`count`) must match, so
 * a new site in the same function is a new finding rather than silently covered; each needs a
 * `reason` a reviewer can re-check against the code.
 */
export const ALLOWLIST = [
  {
    file: "packages/server/src/tools/m3/attachment-tools.ts",
    fn: "handler",
    sink: "readableRel",
    count: 3,
    reason:
      "findAttachmentReferences walks the vault ROOT (no `sub`). walkVault does not descend a " +
      "symlinked directory (Dirent.isDirectory is false for a link), and a root walk cannot start " +
      "through one, so every referrer path it returns has relPath === aclRel by construction.",
  },
  {
    file: "packages/server/src/search/indexing/index-vault.ts",
    fn: "indexVault",
    sink: "isReadableNote",
    count: 1,
    reason:
      "isReadableNote maps the walked display path to its ACL identity through walkedSet (set " +
      "from walkIdentity(e) just before) and only falls back to the name for a path the walk did " +
      "not produce; args.isReadable is handed the identity, never the alias.",
  },
  {
    file: "packages/server/src/search/acl_path_set.ts",
    fn: "ensureAclPathSet",
    sink: "isReadable",
    count: 1,
    reason:
      "opts.isReadable here is the retrieval predicate (readableStoredRow: it judges each stored " +
      "path's acl_path identity). The name-keyed callback registry conflates it with " +
      "index_vault's identity-fed `isReadable: (rel) => readableByFolder(...)`.",
  },
];

/**
 * Functions that ARE the canonical decision (or the canonicalizer feeding it): they resolve the
 * symlink themselves, so a display path handed to them is judged on its target. Their own bodies
 * touch lexical deciders on purpose; they are not wrappers a caller can misuse.
 */
export const CANONICAL_ENTRYPOINTS = new Set([
  "resolveVaultPath",
  "resolveVaultPathChecked",
  "enforcePathAcl",
  "callerCanReadVaultPath",
  "readableResolved",
  "normalizeVaultPath",
  "readableStoredRow",
  "storedAclPathOf",
]);

/** A database column that holds a vault path: `path`, `source_path`, `targetPath`, ... */
const ROW_PATH_COLUMN = /(^|_)path$|[a-z]Path$/;

const D = "D";
const R = "R";
const S = "S";
const C = "C";
const ARRAY_PASS = new Set([
  "filter",
  "slice",
  "sort",
  "toSorted",
  "reverse",
  "toReversed",
  "concat",
  "flat",
  "at",
  "find",
  "findLast",
  "pop",
  "shift",
  "splice",
]);
const ARRAY_CALLBACK = new Set([
  "filter",
  "some",
  "every",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "forEach",
  "map",
  "flatMap",
]);
const FN_TYPES = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);
const TRANSPARENT = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "AwaitExpression",
  "SpreadElement",
]);

const isNode = (v) => v !== null && typeof v === "object" && typeof v.type === "string";
const keep = (set, ...keys) => new Set([...set].filter((l) => keys.includes(l) || l.includes(":")));
const union = (...sets) => new Set(sets.flatMap((s) => [...s]));
const EMPTY = new Set();

function propName(member) {
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  if (member.computed && member.property.type === "Literal") return String(member.property.value);
  return undefined;
}

function unwrap(n) {
  let cur = n;
  while (cur && (TRANSPARENT.has(cur.type) || cur.type === "ChainExpression"))
    cur = cur.expression ?? cur.argument;
  return cur;
}

class Scope {
  constructor(parent) {
    this.parent = parent;
    this.vars = new Map();
  }
  lookup(name) {
    for (let s = this; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name);
    return undefined;
  }
  set(name, binding) {
    this.vars.set(name, binding);
  }
}

/** Cross-file, cross-pass facts: which parameters of which functions reach a lexical decider. */
class Registry {
  constructor() {
    this.reach = new Map(); // ctx id -> Set<param index>
    this.returns = new Map(); // ctx id -> Set<label> (D / R only)
    this.opaque = new Set(); // ctx ids of CANONICAL_ENTRYPOINTS
    this.byName = new Map(); // "fn:name" | "prop:name" -> Set<ctx id>
  }
  addReach(id, i) {
    const s = this.reach.get(id) ?? new Set();
    this.reach.set(id, s);
    s.add(i);
  }
  register(key, id) {
    const s = this.byName.get(key) ?? new Set();
    this.byName.set(key, s);
    s.add(id);
  }
  reachOf(ids) {
    return new Set(
      [...ids].flatMap((id) => (this.opaque.has(id) ? [] : [...(this.reach.get(id) ?? [])])),
    );
  }
  returnsOf(ids) {
    return new Set([...ids].flatMap((id) => [...(this.returns.get(id) ?? [])]));
  }
  signature() {
    return JSON.stringify([
      [...this.reach].map(([k, v]) => [k, [...v].sort()]).sort(),
      [...this.returns].map(([k, v]) => [k, [...v].sort()]).sort(),
      [...this.byName].map(([k, v]) => [k, [...v].sort()]).sort(),
    ]);
  }
}

function analyzeFile(file, source, reg, out) {
  const parsed = parseSync(file, source, { lang: "ts", preserveParens: false });
  if (parsed.errors.some((e) => e.severity === "Error"))
    throw new Error(`${file}: parse error: ${parsed.errors[0]?.message}`);
  const lineOf = (off) => source.slice(0, off).split("\n").length;
  const imported = new Map(); // local name -> imported name (relative or package import alike)
  const fnStack = [];
  const nameStack = [];

  const enclosing = () => nameStack.findLast((n) => n) ?? "<module>";
  let scopeNow = new Scope(undefined);

  function report(node, sink, labels, via) {
    if (labels.has(D))
      out.violations.push({
        file,
        line: lineOf(node.start),
        fn: enclosing(),
        sink,
        via,
        text: source.slice(node.start, Math.min(node.end, node.start + 90)).split("\n")[0],
      });
    for (const l of labels) {
      const m = /^(.*):(\d+)$/.exec(l);
      if (m) reg.addReach(m[1], Number(m[2]));
    }
  }

  function bindPattern(p, labels, scope, fnIds) {
    if (!p) return;
    switch (p.type) {
      case "Identifier":
        scope.set(p.name, { labels, fnIds });
        return;
      case "AssignmentPattern":
        bindPattern(p.left, union(labels, ev(p.right, scope)), scope);
        return;
      case "RestElement":
        bindPattern(p.argument, labels, scope);
        return;
      case "ArrayPattern":
        for (const e of p.elements) bindPattern(e, labels, scope);
        return;
      case "ObjectPattern":
        for (const prop of p.properties) {
          if (prop.type === "RestElement") {
            bindPattern(prop.argument, EMPTY, scope);
            continue;
          }
          const k = !prop.computed && prop.key.type === "Identifier" ? prop.key.name : undefined;
          let l = EMPTY;
          if (k === "relPath" || (k !== undefined && ROW_PATH_COLUMN.test(k) && labels.has(R)))
            l = new Set([D]);
          else if (labels.has(R)) l = EMPTY;
          bindPattern(prop.value, l, scope);
        }
        return;
      default:
        return;
    }
  }

  /** Analyse a function. `elem0` overrides parameter 0 (an array callback's element). */
  function fn(node, scope, name, key, elem0) {
    const id = `${file}:${node.start}`;
    const inner = new Scope(scope);
    node.params.forEach((p, i) => {
      const own = new Set([`${id}:${i}`]);
      bindPattern(p, i === 0 && elem0 ? union(own, elem0) : own, inner);
    });
    if (key && name) reg.register(`${key}:${name}`, id);
    if (name && CANONICAL_ENTRYPOINTS.has(name)) reg.opaque.add(id);
    fnStack.push(id);
    nameStack.push(name);
    const returns = new Set();
    const savedScope = scopeNow;
    scopeNow = inner;
    if (node.body.type === "BlockStatement") {
      body(node.body.body, inner, returns);
    } else {
      for (const l of ev(node.body, inner)) returns.add(l);
    }
    scopeNow = savedScope;
    nameStack.pop();
    fnStack.pop();
    const ret = keep(returns, D, R);
    const prev = reg.returns.get(id);
    if (!prev || prev.size !== ret.size) reg.returns.set(id, ret);
    return { id, ret };
  }

  /** Statements of one block: hoist function declarations, then run in order. */
  function body(stmts, scope, returns) {
    for (const s of stmts) {
      const d = s.type === "ExportNamedDeclaration" ? s.declaration : s;
      if (d?.type === "FunctionDeclaration" && d.id) {
        const { id } = fn(d, scope, d.id.name, "fn");
        scope.set(d.id.name, { labels: EMPTY, fnIds: [id] });
      }
    }
    for (const s of stmts) stmt(s, scope, returns);
  }

  function stmt(s, scope, returns) {
    const d = s.type === "ExportNamedDeclaration" ? s.declaration : s;
    if (!d) return;
    if (d.type === "FunctionDeclaration") return;
    if (d.type === "ReturnStatement") {
      for (const l of d.argument ? ev(d.argument, scope) : EMPTY) returns.add(l);
      return;
    }
    if (d.type === "BlockStatement") {
      body(d.body, new Scope(scope), returns);
      return;
    }
    if (d.type === "ForOfStatement") {
      const inner = new Scope(scope);
      const coll = ev(d.right, scope);
      if (d.left.type === "VariableDeclaration")
        bindPattern(d.left.declarations[0].id, coll, inner);
      stmt(d.body, inner, returns);
      return;
    }
    if (d.type === "VariableDeclaration") {
      for (const dec of d.declarations) {
        const init = dec.init ? unwrap(dec.init) : undefined;
        if (init && FN_TYPES.has(init.type)) {
          const nm = dec.id.type === "Identifier" ? dec.id.name : undefined;
          const { id } = fn(init, scope, nm, "fn");
          bindPattern(dec.id, EMPTY, scope, [id]);
        } else {
          const l = dec.init ? ev(dec.init, scope) : EMPTY;
          bindPattern(dec.id, l, scope);
        }
      }
      return;
    }
    if (d.type === "ImportDeclaration") {
      for (const sp of d.specifiers)
        imported.set(sp.local.name, sp.imported?.name ?? sp.imported?.value ?? sp.local.name);
      return;
    }
    if (d.type === "ClassDeclaration" || d.type === "ClassExpression") {
      ev(d, scope);
      return;
    }
    // Generic statement (if/for/while/try/switch/expression statement): run its sub-nodes in order,
    // with returns collected for the enclosing function.
    visitChildren(d, scope, returns);
  }

  function visitChildren(n, scope, returns) {
    for (const [k, v] of Object.entries(n)) {
      if (k === "type" || k === "start" || k === "end") continue;
      const list = Array.isArray(v) ? v : [v];
      for (const c of list) {
        if (!isNode(c)) continue;
        if (
          c.type.endsWith("Statement") ||
          c.type.endsWith("Declaration") ||
          c.type === "SwitchCase" ||
          c.type === "CatchClause"
        )
          stmt2(c, scope, returns);
        else ev(c, scope);
      }
    }
  }
  function stmt2(c, scope, returns) {
    if (c.type === "SwitchCase" || c.type === "CatchClause") {
      const inner = new Scope(scope);
      if (c.type === "CatchClause" && c.param) bindPattern(c.param, EMPTY, inner);
      visitChildren(c, inner, returns);
    } else if (c.type === "ForStatement" || c.type === "ForInStatement") {
      visitChildren(c, new Scope(scope), returns);
    } else stmt(c, scope, returns);
  }

  function callee(c, scope) {
    const u = unwrap(c);
    if (u.type === "Identifier") {
      const b = scope.lookup(u.name);
      const imp = imported.get(u.name) ?? u.name;
      return {
        name: u.name,
        sinkName: b ? undefined : imp,
        ids: b
          ? (b.fnIds ?? [])
          : imported.has(u.name)
            ? [...(reg.byName.get(`fn:${imp}`) ?? [])]
            : [],
        binding: b,
      };
    }
    if (u.type === "MemberExpression") {
      const nm = propName(u);
      return {
        name: nm,
        sinkName: nm,
        member: u,
        ids: nm
          ? [
              ...(reg.byName.get(`prop:${nm}`) ?? []),
              ...(u.object.type === "ThisExpression"
                ? (reg.byName.get(`method:${file}:${nm}`) ?? [])
                : []),
            ]
          : [],
      };
    }
    return { name: undefined, ids: [], other: u };
  }

  function call(node, scope) {
    const c = callee(node.callee, scope);
    const objLabels = c.member ? ev(c.member.object, scope) : EMPTY;
    if (!c.member && c.other && !FN_TYPES.has(c.other.type)) ev(c.other, scope);
    const calleeFn = c.other && FN_TYPES.has(c.other.type) ? c.other : undefined;
    const isArrayCb = c.member && ARRAY_CALLBACK.has(c.name);
    const argLabels = [];
    const fnReturns = new Set();
    node.arguments.forEach((a, i) => {
      const u = unwrap(a);
      if (u && FN_TYPES.has(u.type)) {
        const { ret } = fn(
          u,
          scope,
          undefined,
          undefined,
          isArrayCb && i === 0 ? keep(objLabels, D, R) : undefined,
        );
        if (isArrayCb && i === 0) for (const l of ret) fnReturns.add(l);
        argLabels.push(EMPTY);
      } else argLabels.push(ev(a, scope));
    });
    if (calleeFn) fn(calleeFn, scope);

    const direct = c.sinkName ? SINKS.get(c.sinkName) : undefined;
    if (direct && !(c.binding && !c.member)) {
      out.directSinkCalls++;
      for (const i of direct) report(node, c.sinkName, argLabels[i] ?? EMPTY, undefined);
    } else if (c.ids.length > 0) {
      const reach = reg.reachOf(c.ids);
      if (reach.size > 0) out.wrapperCalls++;
      for (const i of reach)
        report(node, c.name, argLabels[i] ?? EMPTY, `wrapper ${c.name}(#${i})`);
    }

    // `out.push(e.relPath)` / `set.add(row.path)` make the collection carry the display path.
    if (
      c.member &&
      ["push", "unshift", "add"].includes(c.name) &&
      c.member.object.type === "Identifier"
    ) {
      const b = scope.lookup(c.member.object.name);
      if (b) b.labels = union(b.labels, keep(union(...argLabels), D, R));
    }

    // The value of the call.
    if (c.member && (c.name === "prepare" || c.name === "query")) return new Set([S]);
    if (c.member && ["all", "get", "iterate"].includes(c.name) && objLabels.has(S)) {
      out.rowSources++;
      return new Set([R]);
    }
    if (c.name === "storedAclPathOf" && !c.member) return new Set([C]);
    if (c.binding?.labels?.has(C)) return EMPTY;
    if (c.member && (c.name === "map" || c.name === "flatMap") && fnReturns.size > 0)
      return keep(fnReturns, D, R);
    if (c.member && ARRAY_PASS.has(c.name))
      return keep(c.name === "concat" ? union(objLabels, ...argLabels) : objLabels, D, R);
    if (
      c.member &&
      c.member.object.type === "Identifier" &&
      c.member.object.name === "Array" &&
      c.name === "from"
    )
      return keep(argLabels[0] ?? EMPTY, D, R);
    if (c.ids.length > 0) {
      const r = reg.returnsOf(c.ids);
      if (r.size > 0) return r;
    }
    return keep(union(objLabels, ...argLabels), D);
  }

  function ev(n, scope) {
    if (!isNode(n)) return EMPTY;
    switch (n.type) {
      case "Identifier":
        return scope.lookup(n.name)?.labels ?? EMPTY;
      case "Literal":
        return EMPTY;
      case "MemberExpression": {
        const obj = ev(n.object, scope);
        if (n.computed && n.property.type !== "Literal") {
          ev(n.property, scope);
          return keep(obj, D, R);
        }
        const nm = propName(n);
        if (nm === "relPath") return new Set([D]);
        if (nm !== undefined && ROW_PATH_COLUMN.test(nm) && obj.has(R)) return new Set([D]);
        if (n.computed && typeof n.property.value === "number") return keep(obj, D, R);
        return EMPTY;
      }
      case "CallExpression":
        return call(n, scope);
      case "NewExpression": {
        const ls = n.arguments.map((a) => ev(a, scope));
        if (
          n.callee.type === "Identifier" &&
          (n.callee.name === "Set" || n.callee.name === "Array")
        )
          return keep(ls[0] ?? EMPTY, D, R);
        return EMPTY;
      }
      case "ArrowFunctionExpression":
      case "FunctionExpression":
        fn(n, scope);
        return EMPTY;
      case "TemplateLiteral":
        return keep(union(...n.expressions.map((e) => ev(e, scope))), D);
      case "BinaryExpression":
      case "LogicalExpression":
        return keep(union(ev(n.left, scope), ev(n.right, scope)), D, R);
      case "ConditionalExpression":
        ev(n.test, scope);
        return keep(union(ev(n.consequent, scope), ev(n.alternate, scope)), D, R);
      case "SequenceExpression":
        return n.expressions.map((e) => ev(e, scope)).at(-1) ?? EMPTY;
      case "ArrayExpression":
        return keep(union(...n.elements.map((e) => ev(e, scope))), D, R);
      case "AssignmentExpression": {
        const l = ev(n.right, scope);
        if (n.left.type === "Identifier") {
          const b = scope.lookup(n.left.name);
          if (b) b.labels = union(b.labels, l);
        } else ev(n.left, scope);
        return l;
      }
      case "ObjectExpression": {
        for (const p of n.properties) {
          if (p.type !== "Property") {
            ev(p, scope);
            continue;
          }
          const k = !p.computed && p.key.type === "Identifier" ? p.key.name : undefined;
          const v = unwrap(p.value);
          if (v && FN_TYPES.has(v.type)) fn(v, scope, k, "prop");
          else ev(p.value, scope);
        }
        return EMPTY;
      }
      case "ClassDeclaration":
      case "ClassExpression": {
        for (const m of n.body.body) {
          const k = !m.computed && m.key?.type === "Identifier" ? m.key.name : undefined;
          if (m.type === "MethodDefinition" && m.value) fn(m.value, scope, k, `method:${file}`);
          else if (m.value) ev(m.value, scope);
        }
        return EMPTY;
      }
      default:
        if (TRANSPARENT.has(n.type)) return ev(n.expression ?? n.argument, scope);
        if (n.type.endsWith("Statement") || n.type.endsWith("Declaration")) {
          stmt(n, scope, new Set());
          return EMPTY;
        }
        visitChildren(n, scope, new Set());
        return EMPTY;
    }
  }

  const top = new Scope(undefined);
  scopeNow = top;
  for (const s of parsed.program.body) {
    if (s.type === "ImportDeclaration") stmt(s, top, new Set());
  }
  body(parsed.program.body, top, new Set());
}

/**
 * Analyse `[{ file, source }]` to a fixed point (wrapper facts depend on each other and on files in
 * any order) and return `{ violations, stats }` from the final pass.
 */
export function analyzeSources(files) {
  const reg = new Registry();
  let out;
  let sig = "";
  for (let pass = 0; pass < 8; pass++) {
    out = { violations: [], directSinkCalls: 0, wrapperCalls: 0, rowSources: 0 };
    for (const { file, source } of files) analyzeFile(file, source, reg, out);
    const next = reg.signature();
    if (next === sig) break;
    sig = next;
  }
  const wrapperNames = [...reg.byName]
    .filter(([, ids]) => reg.reachOf(ids).size > 0)
    .map(([k, ids]) => `${k} ${[...ids].join(" ")}`);
  const wrappers = wrapperNames.length;
  return {
    violations: out.violations,
    wrapperNames,
    stats: {
      files: files.length,
      directSinkCalls: out.directSinkCalls,
      wrapperCalls: out.wrapperCalls,
      wrappers,
      rowSources: out.rowSources,
    },
  };
}

/** Split findings into reviewed (allowlisted) and failing; report allowlist entries that matched none. */
export function applyAllowlist(violations, allowlist = ALLOWLIST) {
  const matched = allowlist.map(() => []);
  const failing = [];
  for (const v of violations) {
    const idx = allowlist.findIndex(
      (a) =>
        a.file === v.file &&
        a.fn === v.fn &&
        a.sink === v.sink &&
        matched[allowlist.indexOf(a)].length < a.count,
    );
    if (idx >= 0) matched[idx].push(v);
    else failing.push(v);
  }
  // An entry whose site count drifted (fewer matches than declared, or none) no longer describes
  // the code it was reviewed against.
  const stale = allowlist.filter((a, i) => matched[i].length !== a.count);
  return { failing, allowed: matched.flat(), stale };
}

/** Floor check over the stats; returns a list of problems (empty = ok). */
export function floorProblems(stats, floors = {}) {
  const f = {
    files: MIN_FILES,
    directSinkCalls: MIN_DIRECT_SINK_CALLS,
    wrappers: MIN_WRAPPERS,
    rowSources: MIN_ROW_SOURCES,
    ...floors,
  };
  return Object.entries(f)
    .filter(([k, min]) => stats[k] < min)
    .map(([k, min]) => `${k}: ${stats[k]} < floor ${min}`);
}

function main() {
  const listed = execFileSync("git", ["ls-files", ...SOURCE_GLOBS], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const files = listed.map((file) => ({ file, source: readFileSync(file, "utf8") }));
  const { violations, stats, wrapperNames } = analyzeSources(files);
  if (process.argv.includes("--list-wrappers")) console.log(wrapperNames.join("\n"));
  const { failing, allowed, stale } = applyAllowlist(violations);
  const problems = floorProblems(stats);
  console.log(
    `acl-canonical-identity gate: ${stats.files} file(s) scanned, ${stats.directSinkCalls} lexical ACL call site(s), ` +
      `${stats.wrappers} wrapper(s) (${stats.wrapperCalls} call site(s)), ${stats.rowSources} DB-row source(s); ` +
      `${failing.length} violation(s), ${allowed.length} allowlisted`,
  );
  for (const v of allowed) console.log(`  allowlisted ${v.file}:${v.line} ${v.fn} -> ${v.sink}`);
  for (const v of failing)
    console.log(
      `  ${v.file}:${v.line}  in ${v.fn}: a display path reaches ${v.via ?? `${v.sink}()`}\n    ${v.text}`,
    );
  for (const a of stale)
    console.log(`  STALE allowlist entry (matches no finding): ${a.file} ${a.fn} -> ${a.sink}`);
  for (const p of problems) console.log(`  FLOOR: ${p}`);
  if (failing.length > 0 || stale.length > 0 || problems.length > 0) {
    console.error(
      "\nacl-canonical-identity gate: a path that is a DISPLAY name (a walked entry's relPath, a stored " +
        "row's path) reached a lexical ACL decision. Judge the canonical identity instead: " +
        "`readableEntry` / `entry.aclRel` for walker output, `readableStoredRow` for DB rows, " +
        "`readableResolved` for bridge rows. A genuinely canonical, reviewed use goes in ALLOWLIST " +
        "in scripts/check-acl-canonical-identity.mjs with a reason; a stale entry or a floor miss means " +
        "the scan itself broke.",
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
