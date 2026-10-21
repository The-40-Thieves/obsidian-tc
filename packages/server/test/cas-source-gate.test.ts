// Source-scan gate: every concurrent-modification refusal is built by the shared CAS helper, which
// decides whether the caller may see the current hash. A hand-built `concurrentModification(` call
// elsewhere would echo `actual` to a caller who may not read the note, so it fails here. The floor
// keeps a path change from making the scan find nothing and pass vacuously.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const HELPER = join("vault", "cas.ts");
/** Call sites that route through casConflict today; a smaller count means the scan lost ground. */
const FLOOR = 15;

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
      .flatMap((rel) =>
        read(rel)
          .split("\n")
          .map((line, i) => ({ rel: posix(rel), line: i + 1, text: line.trim() }))
          .filter((l) => /\bconcurrentModification\(/.test(l.text)),
      );
    expect(bypasses).toEqual([]);
  });

  it("the helper-routed call sites meet the floor", () => {
    const sites = files
      .filter((rel) => rel !== HELPER)
      .flatMap((rel) =>
        read(rel)
          .split("\n")
          .filter((line) => /\bcasConflict\(/.test(line)),
      );
    expect(sites.length).toBeGreaterThanOrEqual(FLOOR);
  });
});
