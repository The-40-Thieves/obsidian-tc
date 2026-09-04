// THE-935 fix round 1: the coordinator's ruling on this ticket was that db.busyTimeoutMs must
// reach EVERY open of a shared cache.db/experiential.db, not only the running server's boot path —
// a one-shot CLI command (consolidate, cluster, prefetch, forget, rerun, doctor's probes, ...)
// opening the same file while N stdio servers hold locks is exactly the contention GH #878
// measured. Fix round 0 threaded busyTimeoutMs down to the three DB adapters and the server boot
// path; this file is the SOURCE-SCAN half of round 1, which threaded it to every remaining call
// site: either the site now calls `openDatabase(path, busyTimeoutMs)` directly (a 2nd argument,
// not the bare 1-argument default-falling-back form), or it goes through `openConfiguredDatabase`
// (db/open.ts) instead, the one seam a cfg-scoped caller cannot forget the value at because the
// PARAMETER IS `cfg` ITSELF, not a number an author could omit.
//
// A behavioral test cannot cover this the way db-busy-timeout-config.test.ts covers the three
// adapters — the ~30 call sites here span CLI commands, doctor probes and workspace staging, most
// of which need a fully wired ServerConfig or an on-disk cache.db to exercise end to end. This is
// exactly the "inventory-style source test" the ticket's ruling offered as the alternative: it
// scans every `openDatabase(` call site under packages/server/src and fails the build the moment a
// NEW one reverts to the bare single-argument form, the same way the pre-fix ~19 call sites did.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Tracked .ts source files under packages/server/src, excluding tests — mirrors the convention
 *  scripts/gen-decisions-index.mjs uses (git ls-files, not a filesystem walk, so gitignored/build
 *  output can never contribute a false site). */
function sourceFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "packages/server/src/**/*.ts"], {
    cwd: join(__dirname, "..", "..", ".."),
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.endsWith(".test.ts"));
}

interface CallSite {
  line: number;
  argCount: number;
}

/**
 * From the character index right after `openDatabase(`'s opening paren (i.e. `text[start]` is the
 * first character of the argument list), count top-level (paren-depth-0) arguments by counting
 * top-level commas + 1 — an empty argument list (immediate `)`) counts as 0. Depth starts at 0
 * here because `start` is already INSIDE the call's own parens; a nested `join(a, b)` pushes depth
 * to 1 before its own comma, which must not be mistaken for a second argument to openDatabase.
 */
function countTopLevelArgs(text: string, start: number): number {
  let depth = 0;
  let commas = 0;
  let sawAnyChar = false;
  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) {
        // reached the call's own closing paren
        return sawAnyChar ? commas + 1 : 0;
      }
      depth--;
    } else if (ch === "," && depth === 0) {
      commas++;
    } else if (!/\s/.test(ch)) {
      sawAnyChar = true;
    }
  }
  throw new Error("unbalanced parens scanning openDatabase( call — should be unreachable");
}

/** Every real `openDatabase(` CALL site in `text` (not the `function openDatabase(` declaration,
 *  and not a comment mentioning it) with its 1-indexed line number and top-level argument count. */
function findCallSites(text: string): CallSite[] {
  const sites: CallSite[] = [];
  const re = /openDatabase\(/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
  while ((m = re.exec(text)) !== null) {
    const idx = m.index;
    // Exclude the declaration: `... function openDatabase(`.
    const before = text.slice(Math.max(0, idx - 20), idx);
    if (/function\s+$/.test(before)) continue;
    // Exclude a comment mention: the line this match starts on, trimmed, begins with `//` or `*`
    // (a JSDoc continuation line) — a prose reference like "openDatabase()" in a docstring is not
    // a call this inventory needs to hold to a 2nd argument.
    const lineStart = text.lastIndexOf("\n", idx) + 1;
    const lineText = text.slice(
      lineStart,
      text.indexOf("\n", idx) === -1 ? undefined : text.indexOf("\n", idx),
    );
    if (/^\s*(\/\/|\*)/.test(lineText)) continue;
    const argsStart = idx + "openDatabase(".length;
    const argCount = countTopLevelArgs(text, argsStart);
    const line = text.slice(0, idx).split("\n").length;
    sites.push({ line, argCount });
  }
  return sites;
}

describe("openDatabase / openConfiguredDatabase call-site inventory (THE-935 fix round 1)", () => {
  it("every real openDatabase( call site passes a 2nd (busyTimeoutMs) argument, or goes through openConfiguredDatabase instead", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(50); // sanity: git ls-files actually matched something

    let directCompliant = 0;
    let helperCallSites = 0;
    const nonCompliant: string[] = [];

    for (const rel of files) {
      const abs = join(__dirname, "..", "..", "..", rel);
      const text = readFileSync(abs, "utf8");
      for (const site of findCallSites(text)) {
        if (site.argCount >= 2) {
          directCompliant++;
        } else {
          nonCompliant.push(
            `${rel}:${site.line} — openDatabase( called with ${site.argCount} argument(s), no busyTimeoutMs`,
          );
        }
      }
      // openConfiguredDatabase(cfg, filename) calls also satisfy the ruling ("goes through the
      // helper that does") — count them so the floor below can't be gamed by deleting call sites.
      const helperMatches = text.match(/openConfiguredDatabase\(/g);
      if (helperMatches) helperCallSites += helperMatches.length;
    }

    expect(nonCompliant, nonCompliant.join("\n")).toEqual([]);

    // Floor from the ruling: "asserts a non-empty floor (more than 10 sites found)". Counts both
    // forms — a direct 2-arg openDatabase( call and an openConfiguredDatabase( call — since either
    // one is compliant.
    const total = directCompliant + helperCallSites;
    expect(total).toBeGreaterThan(10);
  });
});
