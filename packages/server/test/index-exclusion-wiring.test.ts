// Source-scan floor for the Excluded files feature: every production reconcile entry point
// (`indexVault` / `indexVaultRecorded` with an argument object) must pass `isIndexExcluded`.
// The pass defaults to "nothing excluded" when the argument is absent, so a new call site that forgets
// it would silently index notes the vault's Excluded files list hides, and no runtime test that
// builds its own vault would notice. Comments are stripped first so a comment cannot satisfy it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../src/", import.meta.url));

function everySourceFile(dir = SRC_ROOT, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...everySourceFile(abs, rel));
    else if (name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The text of each `indexVault(Recorded)?({ ... })` argument object, by brace matching. */
function callArguments(src: string): string[] {
  const out: string[] = [];
  const re = /\bindexVault(?:Recorded)?\(\s*\{/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) {
        out.push(src.slice(open, i + 1));
        break;
      }
    }
  }
  return out;
}

describe("every production indexVault call passes the Excluded files predicate", () => {
  const calls = everySourceFile().flatMap((rel) =>
    callArguments(strip(readFileSync(join(SRC_ROOT, rel), "utf8"))).map((args) => ({ rel, args })),
  );

  it("finds the known call sites (existence floor)", () => {
    const files = new Set(calls.map((c) => c.rel));
    for (const f of [
      "cli/commands/index.ts",
      "runtime/tool-wiring.ts",
      "runtime/plane-wiring.ts",
      "tools/m2/index-tools.ts",
    ]) {
      expect(files, f).toContain(f);
    }
  });

  it("each one names isIndexExcluded", () => {
    const missing = calls.filter((c) => !/\bisIndexExcluded\b/.test(c.args)).map((c) => c.rel);
    expect(missing).toEqual([]);
  });
});
