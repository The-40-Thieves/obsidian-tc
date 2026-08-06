// Tests for where-symbol's DECLARATION KIND MAP — the half that needs a real parser.
//
// WHY THIS FILE EXISTS, and it is worth reading before trimming it:
//
// `where-symbol.test.mjs` covers `classify()` thoroughly. `classify()` was never wrong. The part
// that was wrong for the entire life of the script is the declaration matcher, and it had no test
// because testing it needs ast-grep rather than a pure function. The result was a tool that printed
//
//     DECLARED    0 — no binding found for `experientialTableSpec` (a real zero, not an empty grep)
//
// and exited 1, for a symbol declared at `doctor/table-spec.ts:45`. `verify-ticket-premise` cites
// that exit code as the thing that makes an absence claim checkable, so the false zero propagated
// into premise verification — the one place in this repo that exists to stop false claims.
//
// The cause: text patterns like `function ${n}($$$P) { $$$B }` have no slot for a return-type
// annotation. Every case below is a form that returned 0 under the old patterns. If someone
// reintroduces text patterns, these fail.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DECL_KINDS_BY_LANG, findDeclarations } from "./where-symbol.mjs";

/** ast-grep lives in ci-quality.yml's pinned job, not in the one running `test:scripts`. */
const hasAstGrep = (() => {
  try {
    execFileSync("ast-grep", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// A skip that can never fail is not a gate. Where ast-grep IS provisioned, absence must be an
// ERROR rather than a quiet pass — otherwise a broken install silently retires this whole file.
if (!hasAstGrep && process.env.WHERE_SYMBOL_REQUIRE_ASTGREP === "1") {
  throw new Error(
    "WHERE_SYMBOL_REQUIRE_ASTGREP=1 but ast-grep is not on PATH: these tests would have skipped " +
      "silently in the one job provisioned to run them.",
  );
}

const dir = mkdtempSync(join(tmpdir(), "where-symbol-"));

// Every TS form that the old text patterns missed. The annotation/generics/heritage clauses are
// the point — a bare `function f(a) {}` matched fine and hid the defect.
const TS_FIXTURE = `
const plainConst = 1;
const typedConst: string = "x";
export const exportedTyped: Record<string, number> = {};
let typedLet: string[] = [];
function plainFn(a) { return a; }
function typedFn(a: string): string { return a; }
export function exportedGenericFn<T>(a: T): T[] { return [a]; }
async function asyncTypedFn(): Promise<void> {}
export async function exportedAsyncGeneric<T>(a: T): Promise<T> { return a; }
class PlainClass {}
class HeritageClass extends Object implements Record<string, never> {}
interface PlainIface { a: string }
interface ExtendedIface extends Object { b: string }
type GenericAlias<T> = T[];
enum PlainEnum { A }
`;
const tsFile = join(dir, "fixture.ts");
writeFileSync(tsFile, TS_FIXTURE);

const RUST_FIXTURE = `
pub fn typed_fn(a: &str) -> String { a.to_string() }
fn generic_fn<T: Clone>(a: T) -> T { a }
pub struct S { pub x: u32 }
pub trait Tr { fn m(&self); }
pub const C: u32 = 1;
`;
const rustFile = join(dir, "fixture.rs");
writeFileSync(rustFile, RUST_FIXTURE);

const TS_CASES = [
  ["plainConst", "const/let"],
  ["typedConst", "const/let"], // regression: `const ${n} = $V` has no slot for `: string`
  ["exportedTyped", "const/let"],
  ["typedLet", "const/let"],
  ["plainFn", "function"], // the ONLY function form the old patterns caught
  ["typedFn", "function"], // regression: return-type annotation
  ["exportedGenericFn", "function"], // regression: type params AND return type
  ["asyncTypedFn", "function"],
  ["exportedAsyncGeneric", "function"],
  ["PlainClass", "class"],
  ["HeritageClass", "class"], // regression: extends + implements
  ["PlainIface", "interface"],
  ["ExtendedIface", "interface"], // regression: extends
  ["GenericAlias", "type"], // regression: type params
  ["PlainEnum", "enum"],
];

test("every TypeScript declaration form is found, annotations and heritage included", {
  skip: !hasAstGrep && "ast-grep not on PATH",
}, () => {
  const missed = [];
  for (const [symbol, expectedKind] of TS_CASES) {
    const decls = findDeclarations(symbol, "ts", tsFile);
    if (decls.length !== 1 || decls[0].kind !== expectedKind) {
      missed.push(`${symbol}: expected 1 ${expectedKind}, got ${JSON.stringify(decls)}`);
    }
  }
  assert.deepEqual(missed, [], `declaration forms not detected:\n  ${missed.join("\n  ")}`);
  // Floor: without this a findDeclarations that returned a constant would pass every case above
  // only if it returned exactly one hit of the right kind — but a fixture that failed to WRITE
  // would make the loop vacuous. Assert the corpus is real.
  assert.ok(TS_CASES.length >= 15, "fixture shrank; it must keep covering every declaration form");
});

test("a symbol absent from the fixture yields zero — the matcher is not matching everything", {
  skip: !hasAstGrep && "ast-grep not on PATH",
}, () => {
  assert.deepEqual(findDeclarations("notInTheFixtureAtAll", "ts", tsFile), []);
  // A USE is not a declaration: `Object` is referenced twice in the fixture and declared nowhere.
  assert.deepEqual(findDeclarations("Object", "ts", tsFile), []);
});

test("Rust kinds resolve too, so --lang rust is not a silent zero", {
  skip: !hasAstGrep && "ast-grep not on PATH",
}, () => {
  for (const [symbol, kind] of [
    ["typed_fn", "fn"],
    ["generic_fn", "fn"],
    ["S", "struct"],
    ["Tr", "trait"],
    ["C", "const"],
  ]) {
    const decls = findDeclarations(symbol, "rust", rustFile);
    assert.equal(decls.length, 1, `rust ${symbol}: ${JSON.stringify(decls)}`);
    assert.equal(decls[0].kind, kind);
  }
});

test("an unmapped language throws instead of reporting every symbol undeclared", () => {
  // The failure mode being prevented: returning [] for a language with no kind map would render
  // every symbol in it "not declared" — the same false absence, wearing a new costume.
  assert.throws(() => findDeclarations("anything", "cobol", tsFile), /no declaration-kind map/);
});

test("the language map covers what the CLI advertises", () => {
  for (const lang of ["ts", "tsx", "js", "jsx", "rust"]) {
    assert.ok(Array.isArray(DECL_KINDS_BY_LANG[lang]), `${lang} missing from the kind map`);
    assert.ok(DECL_KINDS_BY_LANG[lang].length > 0, `${lang} maps to no kinds`);
  }
});
