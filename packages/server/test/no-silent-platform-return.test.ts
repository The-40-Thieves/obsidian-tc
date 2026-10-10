// A test that bails out of its own body on win32 (`if (process.platform === "win32") return;`)
// reports PASSED on the Windows leg without asserting anything. `it.skipIf(...)` reports the same
// situation as skipped, which is what it is. This gate holds every test file to the second form.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TEST_DIR = import.meta.dirname;

// An early return keyed on the platform: `if (process.platform <op> "win32") return` with or
// without braces, either comparison direction.
const SILENT_RETURN = /platform\s*[!=]==\s*["']win32["']\s*\)\s*(?:\{\s*)?return\b/;

function testFiles(): string[] {
  return readdirSync(TEST_DIR, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => f.split("\\").join("/"));
}

describe("no test returns early on a platform instead of skipping", () => {
  it("existence floor: the scan reads the whole suite", () => {
    expect(testFiles().length).toBeGreaterThan(100);
  });

  it("the matcher catches the shapes it exists for", () => {
    for (const hit of [
      'if (process.platform === "win32") return;',
      'if (process.platform === "win32") { return; }',
      "if (process.platform === 'win32') return",
      'if (process.platform !== "win32") return;',
    ])
      expect(SILENT_RETURN.test(hit), hit).toBe(true);
    for (const miss of [
      'it.skipIf(process.platform === "win32")("x", () => {',
      'if (process.platform !== "win32") expect(mode).toBe(0o600);',
      'const RACERS = process.platform === "win32" ? 6 : 24;',
    ])
      expect(SILENT_RETURN.test(miss), miss).toBe(false);
  });

  it("no test file contains one", () => {
    // This file's own matcher fixtures are the shapes it forbids, so it is the one exclusion.
    const others = testFiles().filter((f) => f !== "no-silent-platform-return.test.ts");
    expect(others.length).toBeGreaterThan(100);
    const offenders = others.flatMap((f) =>
      readFileSync(join(TEST_DIR, f), "utf8")
        .split("\n")
        .flatMap((line, i) => (SILENT_RETURN.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(offenders).toEqual([]);
  });
});
