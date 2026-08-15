#!/usr/bin/env node
/**
 * THE-837 — the shared embedding transport must name no vendor (source-scan regression guard).
 *
 * `packages/server/src/embeddings/http.ts` is shared by every embedding adapter, both reranker
 * adapters and both model-tier service clients. Until THE-837 its `providerHint` carried a
 * `provider === "<vendor>"` branch, so one of the providers registered in
 * `packages/server/src/providers/registry.ts` got first-run advice the other seven did not. That is
 * a privileged vendor sitting in code that is supposed to be common to all of them, and it grew
 * back once already: `providerHint`'s own docblock records an earlier revision that short-circuited
 * on the same vendor name ABOVE the credential-slot check, reintroducing the wrong-config-block bug
 * the function exists to prevent.
 *
 * Twice is a class, not an incident, which is why this is a standing gate rather than a point fix
 * -- the same reasoning as THE-807's eval-flag closed set. An adapter that needs vendor-specific
 * advice supplies it at its own `postJson` call site via `credentialLessHint`, where the knowledge
 * belongs and where no other provider inherits it.
 *
 * CLOSED SET, DERIVED: the provider names are parsed out of `registry.ts` rather than listed here.
 * A provider added to the registry tomorrow is covered without anyone remembering to edit this
 * file. A hardcoded list would be exactly the maintenance-by-memory this repo has been bitten by
 * (see reference: EXACT-class keys stay current, WARN-class keys rot).
 *
 * STRING LITERALS ONLY, COMMENTS STRIPPED. The violation shape is a provider name used as a VALUE
 * -- `provider === "ollama"`, `case "voyage":`, a lookup keyed on the name. Comments naming a
 * vendor are legitimate and often load-bearing: this repo's 2026-08-10 commentary audit measured
 * that its comments are overwhelmingly invariants rather than narration, and `http.ts`'s own
 * docblocks cite the historical bug by name on purpose. Flagging those would push a reviewer to
 * delete the record of WHY the branch is gone, which is the opposite of the point.
 *
 * Floor checks, per this repo's other source-scan gates (check-boundaries.mjs,
 * check-perf-timing-scope.mjs): a gate that parses zero providers, or scans zero files, has proven
 * nothing and must FAIL rather than report a clean scan.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Both registry maps: `postJson` serves the embedding AND reranker families (see CredentialSlot). */
const REGISTRY = "packages/server/src/providers/registry.ts";
const REGISTRY_MAPS = ["EMBEDDINGS", "RERANKERS"];

/** The shared transport. Adapters are NOT scanned -- each one may name its own vendor. */
const SHARED_TRANSPORT = ["packages/server/src/embeddings/http.ts"];

/**
 * Both registry maps hold at least this many entries today (EMBEDDINGS 8, RERANKERS 2+). A parse
 * returning fewer means the registry's shape moved and the regex stopped matching -- which would
 * otherwise present as "0 provider names to look for, therefore 0 violations, therefore green".
 */
const MIN_EXPECTED_PROVIDERS = 8;

/** Strip block and line comments so a comment may name a vendor freely. Deliberately plain-text,
 *  matching this repo's other source-scan gates rather than an AST walk.
 *
 *  NEWLINES ARE PRESERVED. A block comment is replaced by the same number of newlines it spanned,
 *  not by a single space -- otherwise every reported line number after the first docblock is wrong.
 *  Caught by the failure probe: an injected branch on line 68 was reported as line 33. */
export function stripComments(source) {
  const blank = (m) => "\n".repeat((m.match(/\n/g) ?? []).length);
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every string literal in the source: double, single and backtick. */
export function stringLiterals(source) {
  const out = [];
  const pattern =
    /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  for (const m of source.matchAll(pattern)) {
    const value = m[1] ?? m[2] ?? m[3];
    if (value !== undefined) out.push({ value, index: m.index ?? 0 });
  }
  return out;
}

/** Parse the top-level keys of `const <NAME>: Record<...> = { ... };` -- bare or quoted.
 *
 *  Anchored on the COLON, not a bare prefix. `indexOf("const EMBEDDINGS")` also matches
 *  `const EMBEDDINGS_RENAMED`, which is how the first version of the floor probe below silently
 *  passed: the map had been renamed out from under the gate and it still parsed every key. */
export function registryKeys(source, mapName) {
  const start = source.search(new RegExp(`^const ${mapName}\\s*:`, "m"));
  if (start === -1) return [];
  const end = source.indexOf("\n};", start);
  if (end === -1) return [];
  const block = source.slice(start, end);
  const keys = [];
  for (const m of block.matchAll(/^ {2}(?:"([^"]+)"|([A-Za-z][\w-]*)):\s*\{/gm)) {
    const key = m[1] ?? m[2];
    if (key) keys.push(key);
  }
  return keys;
}

/** Scan the shared transport. Split from the helpers above so `node --test` can import
 *  them without executing the scan -- same shape as check-table-readers.mjs. */
export function main() {
  const registrySource = readFileSync(REGISTRY, "utf8");
  const providers = new Set(REGISTRY_MAPS.flatMap((m) => registryKeys(registrySource, m)));

  if (providers.size < MIN_EXPECTED_PROVIDERS) {
    console.error(
      `embedding-transport gate: parsed only ${providers.size} provider name(s) from ${REGISTRY} ` +
        `(expected >= ${MIN_EXPECTED_PROVIDERS}).\n` +
        "The registry's shape almost certainly changed and the key regex stopped matching. Refusing " +
        "to pass a check that had (near-)nothing to look for.",
    );
    process.exit(1);
  }

  const violations = [];
  let scanned = 0;

  for (const file of SHARED_TRANSPORT) {
    const raw = readFileSync(file, "utf8");
    if (raw.trim().length === 0) {
      console.error(`embedding-transport gate: ${file} is empty. Refusing to pass a vacuous scan.`);
      process.exit(1);
    }
    scanned += 1;
    const source = stripComments(raw);
    for (const { value, index } of stringLiterals(source)) {
      if (!providers.has(value)) continue;
      violations.push({ file, line: source.slice(0, index).split("\n").length, value });
    }
  }

  console.log(
    `embedding-transport gate: ${scanned} file(s) scanned against ${providers.size} registered ` +
      `provider name(s), ${violations.length} violation(s)`,
  );
  for (const v of violations) console.log(`  ${v.file}:${v.line}  names provider "${v.value}"`);

  if (violations.length > 0) {
    console.error(
      "\nembedding-transport gate: a provider name registered in providers/registry.ts appears as a " +
        "string literal in the SHARED embedding transport. That transport is common to every " +
        "embedding adapter, both reranker adapters and both model-tier clients, so a name here " +
        "privileges one vendor over all the others -- the exact coupling THE-837 removed, and which " +
        "had already grown back once before it.\n" +
        "Put the vendor-specific behaviour in the adapter instead: pass `credentialLessHint` at that " +
        "adapter's own postJson call site (see ollamaProvider in embeddings/providers.ts). If the " +
        "name belongs in a COMMENT documenting why, that is fine and this gate ignores comments.",
    );
    process.exit(1);
  }

  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
