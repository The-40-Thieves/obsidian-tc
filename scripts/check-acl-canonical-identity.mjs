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
 *   I  a tool input: the `input` / `args` parameter, or a handler's first parameter. Its `path`-shaped
 *      fields are D, so a path the caller named is judged on its canonical identity like any other.
 *   P  a parameter of the function being analysed, so a helper that forwards its parameter to a
 *      lexical ACL predicate is itself a SINK for its callers (a wrapper), however many layers deep,
 *      whether it is a local const, a function declaration, an imported function, an object-property
 *      callback (`isReadable: (p) => readableRel(...)`) or a class method.
 *
 * A callback is also followed through the CALL, not only through a member name: when a caller hands
 * a sink-reaching predicate to a helper (`plan(root, readable)`, `planMoves({ visible })`), the
 * helper's parameter — or the options-object property it destructures — inherits the callback's
 * reach, and invoking it with a display path (`readable(p)`, `visible(p)`) is a violation at the
 * invocation site. A canonical predicate (readableResolved, callerMayReadNote over
 * callerCanReadVaultPath, ...) has no reach, so handing one over is silent.
 *
 * D flows through aliases, destructuring, for-of, array callbacks, template literals, string methods,
 * ternaries and unknown calls; a member read other than `.aclRel` / `.abs`, or a `storedAclPathOf(...)`
 * result, drops it. A violation is D reaching a lexical decider (see SINKS) or a wrapper forwarding to
 * one. The sanctioned roads are untouched: `readableEntry`, `readableStoredRow`, `readableResolved`,
 * `callerCanReadVaultPath`, `enforcePathAcl`.
 *
 * Known limits (not a proof): row-ness does not survive an unannotated helper in another file's return
 * type, a path stored in an object field and read back later is invisible, and the wrapper registry is
 * keyed by name, so unrelated callbacks sharing a property name share a verdict (false POSITIVES, which
 * the reviewed ALLOWLIST below resolves with a reason).
 *
 * Floors (a scan that finds nothing is not a pass): enough files, ACL call sites, wrappers and DB-row
 * sources; and every ALLOWLIST entry must still match a finding, so a stale exemption cannot linger.
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
// Invocations seen through a callback-shaped binding (a function-typed parameter, or a property
// destructured from one), whether or not any caller's callback was found to reach a decider.
// Floored so the callback-following below cannot silently stop scanning (a broken cbRef binding
// would otherwise read as zero violations).
const MIN_CALLBACK_INVOCATIONS = 10;

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
 * Reviewed exemptions: a lexical decision on a display-shaped value that is already canonical. `file`,
 * function, sink and `count` must match; each needs a `reason`. Empty: the identity is a branded type
 * (AclPath), so a former exemption is a compile-time error. A new entry needs review and a test change.
 */
export const ALLOWLIST = [];

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
  "defaultDeniedUnderEitherName",
]);

/** A database column that holds a vault path: `path`, `source_path`, `targetPath`, ... */
const ROW_PATH_COLUMN = /(^|_)path$|[a-z]Path$/;
/** A tool input field that names a vault path. */
const INPUT_PATH_KEY = /(^|_)path$|[a-z]Path$|^(paths|from|to|folder|sub)$/;

const D = "D";
const R = "R";
const S = "S";
const C = "C";
const I = "I";
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

const PARAM_LABEL = /^(.*):(\d+)$/;
/** A property-of-parameter label: `<fn ctx id>:<param index>.<prop key>`. PARAM_LABEL does not
 *  match it (it ends in a key, not digits), so it is never read as a callback reference. */
const PROP_LABEL = /^(.*):(\d+)\.(.+)$/;
/** The parameter-shaped labels of a value (`<fn ctx id>:<param index>`), as callback references.
 *  Used only where the value IS the parameter (a destructure of it), never on a label that merely
 *  flowed through a call's return value: `const isReadable = readableStoredRow(db, id, decide)`
 *  carries `decide`'s label but invoking it runs the canonicalizer first, so it is not the
 *  callback. */
function cbRefsOf(labels) {
  const out = [];
  for (const l of labels) {
    const m = PARAM_LABEL.exec(l);
    if (m) out.push({ id: m[1], index: Number(m[2]) });
  }
  return out;
}

const isNode = (v) => v !== null && typeof v === "object" && typeof v.type === "string";
const keep = (set, ...keys) => new Set([...set].filter((l) => keys.includes(l) || l.includes(":")));
const union = (...sets) => new Set(sets.flatMap((s) => [...s]));
const EMPTY = new Set();
const compareSignatureValues = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));

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
    // fn ctx id -> Map<param index, Set<prop key>>: a PROPERTY of the function's parameter
    // reaches a lexical decider (directly, or through a sibling callback in the same options
    // object). Such a function is a sink for its callers on that property.
    this.reachProp = new Map();
    // fn ctx id -> Map<param index, Set<arg position>>: when a caller passes a sink-reaching
    // callback as argument i, the callee's parameter i forwards those positions to the decider.
    this.cb = new Map();
    // Same, for a callback carried as property K of an options object passed as argument i.
    this.cbProp = new Map(); // fn ctx id -> Map<param index, Map<prop key, Set<arg position>>>
  }
  addReachProp(id, i, key) {
    const m = this.reachProp.get(id) ?? new Map();
    this.reachProp.set(id, m);
    const s = m.get(i) ?? new Set();
    m.set(i, s);
    s.add(key);
  }
  reachPropsOf(ids) {
    return [...ids].flatMap((id) =>
      this.opaque.has(id)
        ? []
        : [...(this.reachProp.get(id) ?? [])].flatMap(([i, keys]) => [...keys].map((k) => [i, k])),
    );
  }
  addCb(id, i, pos) {
    const m = this.cb.get(id) ?? new Map();
    this.cb.set(id, m);
    const s = m.get(i) ?? new Set();
    m.set(i, s);
    s.add(pos);
  }
  addCbProp(id, i, key, pos) {
    const m = this.cbProp.get(id) ?? new Map();
    this.cbProp.set(id, m);
    const byKey = m.get(i) ?? new Map();
    m.set(i, byKey);
    const s = byKey.get(key) ?? new Set();
    byKey.set(key, s);
    s.add(pos);
  }
  cbOf(id, i) {
    return this.cb.get(id)?.get(i) ?? EMPTY;
  }
  cbPropOf(id, i, key) {
    return this.cbProp.get(id)?.get(i)?.get(key) ?? EMPTY;
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
      [...this.reach]
        .map(([k, v]) => [k, [...v].sort(compareSignatureValues)])
        .sort(compareSignatureValues),
      [...this.returns]
        .map(([k, v]) => [k, [...v].sort(compareSignatureValues)])
        .sort(compareSignatureValues),
      [...this.byName]
        .map(([k, v]) => [k, [...v].sort(compareSignatureValues)])
        .sort(compareSignatureValues),
      [...this.reachProp]
        .map(([k, v]) => [
          k,
          [...v]
            .map(([i, s]) => [i, [...s].sort(compareSignatureValues)])
            .sort(compareSignatureValues),
        ])
        .sort(compareSignatureValues),
      [...this.cb]
        .map(([k, v]) => [
          k,
          [...v]
            .map(([i, s]) => [i, [...s].sort(compareSignatureValues)])
            .sort(compareSignatureValues),
        ])
        .sort(compareSignatureValues),
      [...this.cbProp].map(([k, v]) => [
        k,
        [...v]
          .map(([i, m]) => [
            i,
            [...m]
              .map(([kk, s]) => [kk, [...s].sort(compareSignatureValues)])
              .sort(compareSignatureValues),
          ])
          .sort(compareSignatureValues),
      ]),
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
      const m = PARAM_LABEL.exec(l);
      if (m) reg.addReach(m[1], Number(m[2]));
      const pm = PROP_LABEL.exec(l);
      if (pm) reg.addReachProp(pm[1], Number(pm[2]), pm[3]);
    }
  }

  function bindPattern(p, labels, scope, fnIds, cbRefs) {
    if (!p) return;
    const refs = cbRefs ?? [];
    switch (p.type) {
      case "Identifier":
        scope.set(p.name, { labels, fnIds, cbRefs: refs });
        return;
      case "AssignmentPattern":
        bindPattern(p.left, union(labels, ev(p.right, scope)), scope, undefined, refs);
        return;
      case "RestElement":
        bindPattern(p.argument, labels, scope, undefined, refs);
        return;
      case "ArrayPattern":
        for (const e of p.elements) bindPattern(e, labels, scope, undefined, refs);
        return;
      case "ObjectPattern": {
        // A destructure of a parameter (an options object): each property stays tied to that
        // parameter by a prop label, so a property — data or callback — that reaches a lexical
        // decider makes this function a sink for its callers on that property.
        const base = cbRefs ?? cbRefsOf(labels);
        for (const prop of p.properties) {
          if (prop.type === "RestElement") {
            bindPattern(prop.argument, EMPTY, scope);
            continue;
          }
          const k = !prop.computed && prop.key.type === "Identifier" ? prop.key.name : undefined;
          let l = EMPTY;
          if (
            k === "relPath" ||
            (k !== undefined && ROW_PATH_COLUMN.test(k) && labels.has(R)) ||
            (k !== undefined && INPUT_PATH_KEY.test(k) && labels.has(I))
          )
            l = new Set([D]);
          else if (labels.has(R)) l = EMPTY;
          if (k !== undefined && base.length > 0)
            l = union(l, new Set(base.map((r) => `${r.id}:${r.index}.${k}`)));
          bindPattern(
            prop.value,
            l,
            scope,
            undefined,
            k === undefined ? [] : base.map((r) => ({ ...r, prop: k })),
          );
        }
        return;
      }
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
      if (p.type === "Identifier" && /^(input|args)$/.test(p.name)) own.add(I);
      bindPattern(p, i === 0 && elem0 ? union(own, elem0) : own, inner, undefined, [
        { id, index: i },
      ]);
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

  /** The function ctx ids an argument refers to: an inline function's own id, a local binding's,
   *  or an imported function's (by name, cross-file). */
  function fnIdsOf(a, scope) {
    const u = unwrap(a);
    if (u && FN_TYPES.has(u.type)) return [`${file}:${u.start}`];
    if (u && u.type === "Identifier") {
      const b = scope.lookup(u.name);
      if (b?.fnIds) return b.fnIds;
      const imp = imported.get(u.name);
      if (imp) return [...(reg.byName.get(`fn:${imp}`) ?? [])];
    }
    return [];
  }

  /** Analyse an options-object argument once, capturing each property's labels (ev's
   *  ObjectExpression case, plus the per-key record the prop road needs). */
  function evalObjectProps(n, scope) {
    const props = new Map();
    for (const p of n.properties) {
      if (p.type !== "Property") {
        ev(p, scope);
        continue;
      }
      const k = !p.computed && p.key.type === "Identifier" ? p.key.name : undefined;
      const v = unwrap(p.value);
      if (v && FN_TYPES.has(v.type)) {
        fn(v, scope, k, "prop", k === "handler" ? new Set([I]) : undefined);
        if (k !== undefined) props.set(k, EMPTY);
      } else {
        const l = ev(p.value, scope);
        if (k !== undefined) props.set(k, l);
      }
    }
    return props;
  }

  function call(node, scope) {
    const c = callee(node.callee, scope);
    const objLabels = c.member ? ev(c.member.object, scope) : EMPTY;
    if (!c.member && c.other && !FN_TYPES.has(c.other.type)) ev(c.other, scope);
    const calleeFn = c.other && FN_TYPES.has(c.other.type) ? c.other : undefined;
    const isArrayCb = c.member && ARRAY_CALLBACK.has(c.name);
    const argLabels = [];
    const argProps = [];
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
      } else if (u && u.type === "ObjectExpression") {
        argProps[i] = evalObjectProps(u, scope);
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
    // Prop road: the callee judges a PROPERTY of one of its parameters lexically (directly, or
    // through a sibling callback in the same options object), so the matching property of this
    // call's argument is judged here, at the call site.
    if (c.ids.length > 0)
      for (const [j, k] of reg.reachPropsOf(c.ids))
        report(
          node,
          c.name,
          argProps[j]?.get(k) ?? argLabels[j] ?? EMPTY,
          `wrapper ${c.name}(#${j}.${k})`,
        );

    // Callback road, consuming side: this call goes through a callback-shaped binding (a
    // function-typed parameter, or a property destructured from one). The positions some caller's
    // callback forwards to a lexical decider are judged here, on this invocation's arguments.
    if (c.binding?.cbRefs?.length) {
      out.callbackInvocations++;
      for (const ref of c.binding.cbRefs) {
        const positions =
          ref.prop === undefined
            ? reg.cbOf(ref.id, ref.index)
            : reg.cbPropOf(ref.id, ref.index, ref.prop);
        for (const pos of positions)
          report(
            node,
            c.name ?? "callback",
            argLabels[pos] ?? EMPTY,
            `callback ${c.name}(#${pos})`,
          );
      }
    }
    // Callback road, recording side: a function argument whose own parameters reach a lexical
    // decider makes the callee's matching parameter (or, in an options object, the matching
    // property) a callback that forwards those positions.
    if (c.ids.length > 0)
      node.arguments.forEach((a, i) => {
        const u = unwrap(a);
        if (u && u.type === "ObjectExpression")
          for (const p of u.properties) {
            if (p.type !== "Property") continue;
            const k = !p.computed && p.key.type === "Identifier" ? p.key.name : undefined;
            if (k === undefined) continue;
            for (const pos of reg.reachOf(fnIdsOf(p.value, scope)))
              for (const id of c.ids) reg.addCbProp(id, i, k, pos);
          }
        for (const pos of reg.reachOf(fnIdsOf(a, scope)))
          for (const id of c.ids) reg.addCb(id, i, pos);
      });

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
      // A returned parameter i is the CALLER's argument i, so a pass-through keeps its taint.
      if (r.size > 0)
        return new Set(
          [...r].flatMap((l) => {
            const m = /^(.*):(\d+)$/.exec(l);
            return m && c.ids.includes(m[1]) ? [...keep(argLabels[+m[2]] ?? EMPTY, D, R)] : [l];
          }),
        );
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
        if (nm !== undefined && INPUT_PATH_KEY.test(nm) && obj.has(I)) return new Set([D]);
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
          if (v && FN_TYPES.has(v.type))
            fn(v, scope, k, "prop", k === "handler" ? new Set([I]) : undefined);
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
    out = {
      violations: [],
      directSinkCalls: 0,
      wrapperCalls: 0,
      rowSources: 0,
      callbackInvocations: 0,
    };
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
      callbackInvocations: out.callbackInvocations,
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
    callbackInvocations: MIN_CALLBACK_INVOCATIONS,
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
      `${stats.wrappers} wrapper(s) (${stats.wrapperCalls} call site(s)), ${stats.rowSources} DB-row source(s), ` +
      `${stats.callbackInvocations} callback invocation(s); ` +
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
        "row's path) or a caller's input path reached a lexical ACL decision. Judge the canonical " +
        "identity instead: `readableEntry` / `entry.aclRel` for walker output, `readableStoredRow` " +
        "for DB rows, `readableResolved` (or `memoizedReadableResolved`) for a path a caller named. " +
        "A genuinely canonical, reviewed use goes in ALLOWLIST " +
        "in scripts/check-acl-canonical-identity.mjs with a reason; a stale entry or a floor miss means " +
        "the scan itself broke.",
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
