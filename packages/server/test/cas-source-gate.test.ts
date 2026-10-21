// Source-scan gate: every concurrent-modification refusal is built by the shared CAS helper, which
// decides whether the caller may see the current hash. A hand-built `concurrentModification(` call
// elsewhere would echo `actual` to a caller who may not read the note, so it fails here. The scan
// also catches the name used without a direct call (an alias, or bracket or destructured access),
// which would route around the helper just the same. The floor keeps a path change from making the
// scan find nothing and pass vacuously.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const HELPER = join("vault", "cas.ts");
/** Call sites that route through the helper today; a smaller count means the scan lost ground. */
const FLOOR = 25;

/** Any mention of the error's name outside the helper, however it is reached. */
const BYPASS = /\bconcurrentModification\b/;

function bypassLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => BYPASS.test(line));
}

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map((p) => String(p))
    .filter((p) => p.endsWith(".ts"))
    .map((p) => relative(SRC, join(SRC, p)));
}

const posix = (p: string): string => p.split(sep).join("/");

describe("CAS source gate", () => {
  const files = sourceFiles();
  const read = (rel: string): string => readFileSync(join(SRC, rel), "utf8");

  it("the scan sees the whole source tree and the helper it exempts", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain(HELPER);
    expect(read(HELPER)).toMatch(/err\.concurrentModification\(/);
  });

  it("no file outside the helper calls concurrentModification( directly", () => {
    const bypasses = files
      .filter((rel) => rel !== HELPER)
      .flatMap((rel) => bypassLines(read(rel)).map((text) => ({ rel: posix(rel), text })));
    expect(bypasses).toEqual([]);
  });

  it("alias: bracket, destructured and aliased access to the error name is caught", () => {
    const aliases = [
      'throw err["concurrentModification"]("x", {});',
      "const cm = err.concurrentModification;",
      "const { concurrentModification: cm } = err;",
      "throw err['concurrentModification'](msg);",
    ];
    for (const line of aliases) expect(bypassLines(line), line).toEqual([line]);
  });

  it("the helper-routed call sites meet the floor", () => {
    const sites = files
      .filter((rel) => rel !== HELPER)
      .flatMap((rel) =>
        read(rel)
          .split("\n")
          .filter((line) => /\b(checkCas|casConflict)\(/.test(line)),
      );
    expect(sites.length).toBeGreaterThanOrEqual(FLOOR);
  });
});
