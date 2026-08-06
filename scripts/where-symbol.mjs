#!/usr/bin/env node
// Answer "where is this symbol, structurally" — and separate CODE from PROSE ABOUT CODE.
//
// WHY THIS EXISTS: every verification workflow in this repo tells you to grep for a symbol before
// concluding it is absent, and `rg` cannot tell a declaration from a sentence mentioning it. That
// gap has produced real wrong answers here:
//
//   THE-747 — `rg -c MAX_JUDGED citation.ts` returns 4. Two of those are prose in a comment
//   explaining that reflect.ts's identically-named constant was DELETED. The comment is the
//   residue of the very removal being investigated, and it counts as evidence FOR the thing it
//   documents the absence of. Structurally there are 2 occurrences: the declaration at :34 and
//   one use at :434.
//
//   The same shape, twice more: a `(THE-629)` citation in doctor.ts was later read back as
//   independent confirmation of THE-629 ("circular corroboration"), and a stale comment in
//   citation.ts was quoted forward for MONTHS as proof a feature was unbuildable.
//
// A comment is not a call site. This script is the difference.
//
// It reports THREE buckets, and the third is the point:
//
//   DECLARED    — the symbol is bound here (const/let/function/class/interface/type/enum)
//   USED        — a structural occurrence that is not a declaration: a real reference
//   PROSE-ONLY  — lines `rg` matches that the parser does NOT. Comments, strings, docs.
//                 A high number here is the warning that a textual count is about to mislead you.
//
// Exit 1 when nothing is DECLARED, so "this symbol does not exist" is a checkable claim rather
// than an empty grep you have to interpret. `[[verify-ticket-premise]]` requires stating zero
// results explicitly; this makes the zero load-bearing.
//
// Implementation note: ast-grep, not the bare `tree-sitter` CLI. ast-grep IS tree-sitter with the
// grammars already embedded, is already pinned in mise (0.45.0) and already pinned + checksummed
// in ci-quality.yml. `/usr/bin/tree-sitter` is installed on the dev box but has ZERO parser
// directories configured and cannot parse a file until grammars are cloned and built — it would
// be a second, unpinned copy of a capability this repo already gates on.
import { execFileSync } from "node:child_process";

// Declaration forms, matched by NODE KIND and name FIELD — never by a source-text pattern.
//
// THE BUG THIS REPLACES is the exact failure this script exists to prevent, committed by the script
// itself. The previous implementation matched text patterns like `function ${n}($$$P) { $$$B }`.
// That pattern has no slot for a RETURN-TYPE ANNOTATION, which sits between the parameter list and
// the body — so in a strict-TypeScript repo it matched almost nothing:
//
//   function plain(a) { … }                              matched
//   function typed(a: string): string { … }              NO MATCH
//   export function exFn<T>(a: T): T[] { … }             NO MATCH
//
// Every other pattern had the same defect wherever a declaration carries an optional clause the
// pattern has no slot for — `extends`, `implements`, type parameters, or a type annotation:
//
//   interface Extended extends Plain { … }               NO MATCH
//   class C<T> implements I { … }                        NO MATCH
//   type GenericAlias<T> = T[]                           NO MATCH
//   const typedConst: string = "x"                       NO MATCH
//
// So `where <anyTypedFunction>` printed `DECLARED 0 — a real zero, not an empty grep` and exited 1,
// which is this repo's worst failure shape: a false absence wearing an authoritative label, in the
// tool other workflows cite when they need an absence to be checkable. Measured 2026-08-06 —
// `experientialTableSpec` reported 0 while declared at `doctor/table-spec.ts:45`.
//
// Kind+field matching has no such holes: the annotation, the generics and the heritage clauses are
// siblings of the name field, not text the pattern must anticipate. Verified against a fixture
// covering all of the forms above — see `where-symbol.patterns.test.mjs`, which is the test that
// did not exist and is why this survived. `classify()` was well covered; the pattern list was not.
//
// Kind names are GRAMMAR-specific, so this is a per-language map. An unknown language must fail
// loudly (below) rather than return no declarations — that would be this same bug in a new costume.
const DECL_KINDS_BY_LANG = {
  ts: [
    ["const/let", "variable_declarator"],
    ["function", "function_declaration"],
    ["class", "class_declaration"],
    ["interface", "interface_declaration"],
    ["type", "type_alias_declaration"],
    ["enum", "enum_declaration"],
  ],
  rust: [
    ["fn", "function_item"],
    ["struct", "struct_item"],
    ["enum", "enum_item"],
    ["trait", "trait_item"],
    ["const", "const_item"],
    ["static", "static_item"],
    ["type", "type_item"],
  ],
};
// The JS/TSX grammars share TypeScript's node names for every form above.
for (const alias of ["tsx", "js", "jsx"]) DECL_KINDS_BY_LANG[alias] = DECL_KINDS_BY_LANG.ts;

export { DECL_KINDS_BY_LANG };

/**
 * Declaration hits for one node KIND, by exact name.
 *
 * Unlike `sg()` below, this does NOT swallow failures. A malformed rule and a genuine absence both
 * produce an empty result, and treating them alike is precisely how the pattern defect above
 * survived: `sg()` discards stderr (`stdio: [,, "ignore"]`) and returns `[]` from its catch, so a
 * query that never ran was indistinguishable from a symbol that does not exist. A declaration
 * lookup is the one call whose zero this script asks readers to TRUST, so its zero has to be earned.
 */
function sgRule(kind, symbol, lang, path) {
  const rule = JSON.stringify({
    id: "where-symbol",
    language: lang,
    rule: { kind, has: { field: "name", regex: `^${symbol}$` } },
  });
  let out;
  try {
    out = execFileSync("ast-grep", ["scan", "--inline-rules", rule, "--json=compact", path], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const why = (e.stderr || e.message || "").toString().trim().split("\n")[0];
    throw new Error(`ast-grep failed for kind \`${kind}\` (${lang}): ${why}`);
  }
  return out.trim() ? JSON.parse(out) : [];
}

/**
 * Every declaration of `symbol` under `path`, as `[{kind, at}]`.
 *
 * Exported so the KIND MAP can be tested against a real parser. That is the gap that let the
 * previous text patterns ship broken: `classify()` was thoroughly covered, and the pattern list —
 * the part that actually decides whether a symbol is declared — had no test at all, because it
 * needed a parser to exercise. See `where-symbol.patterns.test.mjs`.
 */
export function findDeclarations(symbol, lang, path) {
  const kinds = DECL_KINDS_BY_LANG[lang];
  if (!kinds) throw new Error(`no declaration-kind map for lang \`${lang}\``);
  const out = [];
  for (const [label, kind] of kinds) {
    for (const m of sgRule(kind, symbol, lang, path)) {
      out.push({ kind: label, at: `${m.file}:${m.range.start.line + 1}` });
    }
  }
  return out;
}

/** ast-grep JSON, or [] when the pattern simply does not match (exit 1 is "no matches", not an error). */
function sg(pattern, lang, path) {
  try {
    const out = execFileSync(
      "ast-grep",
      ["run", "-p", pattern, "-l", lang, "--json=compact", path],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.trim() ? JSON.parse(out) : [];
  } catch {
    return [];
  }
}

/** Every LINE ripgrep matches — the textual view this script exists to contrast against. */
function rgLines(symbol, path) {
  try {
    const out = execFileSync("rg", ["-n", "--no-heading", "--word-regexp", "-F", symbol, path], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const m = /^(.*?):(\d+):/.exec(l);
        return m ? `${m[1]}:${m[2]}` : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The whole judgement of this script, as a pure function so it is testable without a parser.
 *
 * @param declared    [{kind, at}] declaration-pattern hits
 * @param structural  ["file:line"] bare-identifier hits (declarations INCLUDED)
 * @param textual     ["file:line"] ripgrep hits
 * @returns {{declared, used, proseOnly}} — `used` is structural-minus-declared, `proseOnly` is
 *          textual-minus-structural. The second subtraction is the one that matters: it is exactly
 *          the set a grep count would have silently folded into "occurrences".
 */
export function classify(declared, structural, textual) {
  const declaredAt = new Set(declared.map((d) => d.at));
  const structuralSet = new Set(structural);
  return {
    declared,
    used: [...new Set(structural.filter((a) => !declaredAt.has(a)))].sort(),
    proseOnly: [...new Set(textual.filter((a) => !structuralSet.has(a)))].sort(),
  };
}

/** True when this module is the entry point, so importing it for tests runs no CLI. */
const isMain = process.argv[1]?.endsWith("where-symbol.mjs");
if (!isMain) {
  // imported for tests — export surface only
} else {
  const args = process.argv.slice(2);
  const symbol = args.find((a) => !a.startsWith("-"));
  const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const asJson = args.includes("--json");
  const lang = flag("lang", "ts");
  const path = flag("path", "packages");

  if (!symbol) {
    console.error("usage: where-symbol <SYMBOL> [--lang ts] [--path packages] [--json]");
    process.exit(2);
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol)) {
    console.error(`refusing to search for ${JSON.stringify(symbol)}: not a single identifier.`);
    process.exit(2);
  }

  // Refuse rather than return an empty declaration set. Node-kind names are grammar-specific, so a
  // language with no map here would report DECLARED 0 for every symbol in it — a false absence
  // presented as a checkable zero, which is the defect this script was just repaired for.
  const kinds = DECL_KINDS_BY_LANG[lang];
  if (!kinds) {
    console.error(
      `no declaration-kind map for --lang ${lang}. Known: ${Object.keys(DECL_KINDS_BY_LANG).sort().join(", ")}.\n` +
        "Add its node kinds rather than letting this report every symbol as undeclared.",
    );
    process.exit(2);
  }

  const loc = (m) => `${m.file}:${m.range.start.line + 1}`;

  // Declarations first, so a structural occurrence can be classified as declaration-or-use.
  const declarations = findDeclarations(symbol, lang, path);

  // A bare identifier pattern matches identifier NODES: never a comment, never a string body.
  const structural = sg(symbol, lang, path).map(loc);
  const { declared, used, proseOnly } = classify(declarations, structural, rgLines(symbol, path));

  if (asJson) {
    console.log(JSON.stringify({ symbol, lang, path, declared, used, proseOnly }, null, 2));
  } else {
    console.log(`symbol: ${symbol}   lang: ${lang}   path: ${path}\n`);
    if (declared.length === 0) {
      console.log(
        `DECLARED    0 — no binding found for \`${symbol}\` (a real zero, not an empty grep)`,
      );
    } else {
      console.log(`DECLARED    ${declared.length}`);
      for (const d of declared) console.log(`  ${d.kind.padEnd(15)} ${d.at}`);
    }
    console.log(`\nUSED        ${used.length}`);
    for (const u of used.slice(0, 40)) console.log(`  ${u}`);
    if (used.length > 40) console.log(`  … ${used.length - 40} more`);
    console.log(`\nPROSE-ONLY  ${proseOnly.length}   (rg matches these; the parser does not)`);
    for (const p of proseOnly.slice(0, 20)) console.log(`  ${p}`);
    if (proseOnly.length > 20) console.log(`  … ${proseOnly.length - 20} more`);
    if (proseOnly.length > 0) {
      const total = structural.length + proseOnly.length;
      const pct = Math.round((proseOnly.length / total) * 100);
      console.log(
        `\n  ${pct}% of textual matches for \`${symbol}\` are prose. A grep count here overstates` +
          `\n  its presence in code by ${proseOnly.length} line${proseOnly.length === 1 ? "" : "s"}.`,
      );
    }
  }

  // Nothing bound anywhere is the answer a premise check most often needs, so make it checkable.
  process.exit(declared.length === 0 ? 1 : 0);
}
