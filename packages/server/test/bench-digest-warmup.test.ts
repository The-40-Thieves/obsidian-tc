// CodSpeed measures `chunkNote::small note` on the Simulation instrument, and chunkNote hashes every
// chunk. Node builds its digest tables on a process's first createHash, at a cost of two syscalls,
// so that one-time setup has to happen at module load or it lands inside the measured region and
// makes the benchmark bimodal (~511us vs ~718us, surfacing as a false ~29% regression). The warm-up
// is a bare side-effecting statement that reads like dead code, and CodSpeed is not one of main's
// required status checks, so nothing else would catch its removal. This test is that guard.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BENCH = fileURLToPath(new URL("../bench/markdown.bench.ts", import.meta.url));

describe("markdown benchmarks: the node:crypto digest init is warmed at module load", () => {
  it("hashes once before the first bench, so no bench body pays the lazy init", () => {
    const src = readFileSync(BENCH, "utf8");

    // Floor: this guard only means anything while the file still benches the hashing path.
    expect(src).toMatch(/\bchunkNote\(/);

    // Column 0 == module scope; a call inside a bench body would be indented.
    const warm = src.search(/^contentHash\(/m);
    const firstBench = src.search(/^test\(/m);

    expect(firstBench).toBeGreaterThan(-1);
    expect(warm, "markdown.bench.ts must call contentHash() at module scope").toBeGreaterThan(-1);
    expect(warm, "the warm-up must run before the first bench").toBeLessThan(firstBench);
  });
});
