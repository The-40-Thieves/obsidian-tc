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

const DECL_PATTERNS = [
  ["const", (n) => `const ${n} = $V`],
  ["let", (n) => `let ${n} = $V`],
  ["function", (n) => `function ${n}($$$P) { $$$B }`],
  ["async function", (n) => `async function ${n}($$$P) { $$$B }`],
  ["class", (n) => `class ${n} { $$$B }`],
  ["interface", (n) => `interface ${n} { $$$B }`],
  ["type", (n) => `type ${n} = $T`],
  ["enum", (n) => `enum ${n} { $$$B }`],
];

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

  const loc = (m) => `${m.file}:${m.range.start.line + 1}`;

  // Declarations first, so a structural occurrence can be classified as declaration-or-use.
  const declarations = [];
  for (const [kind, mk] of DECL_PATTERNS) {
    for (const m of sg(mk(symbol), lang, path)) declarations.push({ kind, at: loc(m) });
  }

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
