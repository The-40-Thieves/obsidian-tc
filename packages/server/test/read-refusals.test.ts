import { linkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReadRefusals } from "../src/tools/read-refusals";
import { makeTempDir, rmTemp } from "./tmp";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe("ReadRefusals", () => {
  it("returns the raw text of a readable note and counts nothing", () => {
    const root = makeTempDir("obtc-read-refusals-");
    cleanups.push(() => rmTemp(root));
    mkdirSync(join(root, "n"), { recursive: true });
    writeFileSync(join(root, "n", "a.md"), "# A\n");
    const refusals = new ReadRefusals();
    expect(refusals.read(root, "n/a.md")).toBe("# A\n");
    expect(refusals.count).toBe(0);
    expect(refusals.out()).toEqual({});
  });

  it("rethrows a missing note (ENOENT) instead of skipping it", () => {
    const root = makeTempDir("obtc-read-refusals-");
    cleanups.push(() => rmTemp(root));
    const refusals = new ReadRefusals();
    let caught: unknown;
    try {
      refusals.read(root, "gone.md");
    } catch (e) {
      caught = e;
    }
    expect((caught as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(refusals.count).toBe(0);
  });

  it("readBounded returns null for a note over the cap without counting it", () => {
    const root = makeTempDir("obtc-read-refusals-");
    cleanups.push(() => rmTemp(root));
    writeFileSync(join(root, "big.md"), "x".repeat(10));
    const refusals = new ReadRefusals();
    expect(refusals.readBounded(root, "big.md", 10)).toBe("x".repeat(10));
    expect(refusals.readBounded(root, "big.md", 9)).toBeNull();
    expect(refusals.out()).toEqual({});
  });

  it.skipIf(process.platform === "win32")("readBounded counts a refused note", () => {
    const root = makeTempDir("obtc-read-refusals-");
    const outside = makeTempDir("obtc-read-refusals-out-");
    cleanups.push(
      () => rmTemp(root),
      () => rmTemp(outside),
    );
    writeFileSync(join(outside, "src.md"), "# S\n");
    linkSync(join(outside, "src.md"), join(root, "hl.md"));
    const refusals = new ReadRefusals();
    expect(refusals.readBounded(root, "hl.md", 1024)).toBeNull();
    expect(refusals.out()).toEqual({ notes_read_refused: 1 });
  });
});
