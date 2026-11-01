// GH #1433 rec 4, step 2: the argv a child-process embedder host re-runs itself with. A script runs
// under the same runtime; a compiled binary (Bun's virtual FS path) runs by itself.
import { describe, expect, it } from "vitest";
import { selfSpawnArgv } from "../src/embeddings/host/spawn-argv";

describe("selfSpawnArgv", () => {
  it("re-runs a script under the same runtime: [execPath, script]", () => {
    expect(selfSpawnArgv("/srv/obsidian-tc/src/cli.ts", "/usr/bin/bun", [])).toEqual([
      "/usr/bin/bun",
      "/srv/obsidian-tc/src/cli.ts",
    ]);
  });

  it("runs a compiled binary by itself when argv[1] is Bun's virtual FS", () => {
    expect(selfSpawnArgv("/$bunfs/root/obsidian-tc", "/usr/local/bin/obsidian-tc", [])).toEqual([
      "/usr/local/bin/obsidian-tc",
    ]);
  });

  it("recognises the Windows compiled-binary shape the same way", () => {
    expect(selfSpawnArgv("B:/~BUN/root/obsidian-tc.exe", "C:/bin/obsidian-tc.exe", [])).toEqual([
      "C:/bin/obsidian-tc.exe",
    ]);
  });

  it("falls back to [execPath] when there is no entry script", () => {
    expect(selfSpawnArgv("", "/usr/bin/bun", [])).toEqual(["/usr/bin/bun"]);
  });

  it("forwards the parent's execArgv (runtime flags) ahead of the entry script", () => {
    expect(
      selfSpawnArgv("/srv/obsidian-tc/src/cli.ts", "/usr/bin/bun", ["--smol", "--inspect=0"]),
    ).toEqual(["/usr/bin/bun", "--smol", "--inspect=0", "/srv/obsidian-tc/src/cli.ts"]);
  });
});
