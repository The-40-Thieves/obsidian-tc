// The boot reconcile's walk and chunk-state preload used to run as one synchronous block ahead of
// the first per-note yield, so a `tools/call` or SIGTERM arriving in that window waited for it
// (~0.3 s per 20 000 notes, more on a big vault). With an abort signal those phases now hand the
// loop back; without one they stay synchronous. Results must not change either way.
import { describe, expect, it } from "vitest";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault, preloadChunkState } from "../src/search/indexer";
import { createLoopYielder } from "../src/search/indexing/loop-yield";
import { preloadChunkStateCooperative } from "../src/search/indexing/note-plan";
import { buildRepresentationManifest } from "../src/search/representation";
import { walkVault } from "../src/vault/paths";
import { makeM2Vault } from "./m2-helpers";

/** Self-rearming setImmediate counter: a 0 ms interval cannot prove a turn on Windows (~15 ms tick). */
function countTurns(): { count: () => number; stop: () => void } {
  let turns = 0;
  let handle = setImmediate(function tick() {
    turns++;
    handle = setImmediate(tick);
  });
  return { count: () => turns, stop: () => clearImmediate(handle) };
}

// Nested dirs, a name that sorts differently per-directory than per-path ("a-b.md" vs "a/z.md"),
// duplicate bodies (dedup registry order), a frontmatter note and a dot-dir that must stay hidden.
function fixtureFiles(n: number): Record<string, string> {
  const files: Record<string, string> = {
    "a-b.md": "# ab\n\ndash sibling body",
    "a/z.md": "# az\n\nnested body",
    "a/a.md": "# aa\n\nnested body",
    "dup1.md": "same body text for dedup",
    "dup2.md": "same body text for dedup",
    "fm.md": "---\ntags: [x, y]\n---\n# fm\n\n[[a-b]] link",
    ".hidden/x.md": "# hidden",
  };
  for (let i = 0; i < n; i++) files[`d${i % 9}/s${i % 4}/n${i}.md`] = `# note ${i}\n\nbody ${i}`;
  return files;
}

describe("indexVault walk phase with an abort signal", { timeout: 60_000 }, () => {
  const run = async (
    n: number,
    signal: AbortSignal | undefined,
    warm: boolean,
  ): Promise<{ ticksAtWalkEnd: number; stats: unknown; chunkState: unknown }> => {
    const v = makeM2Vault({ files: fixtureFiles(n) });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      let ticksAtWalkEnd = -1;
      const turns = countTurns();
      try {
        const base = {
          db: v.db,
          provider,
          vaultId: v.id,
          root: v.root,
          representation: buildRepresentationManifest(provider, {}),
        };
        if (warm) await indexVault({ ...base, isReadable: () => true });
        const before = turns.count();
        const stats = await indexVault({
          ...base,
          // The first readability check happens right after the walk, before anything is read.
          isReadable: () => {
            if (ticksAtWalkEnd < 0) ticksAtWalkEnd = turns.count() - before;
            return true;
          },
          ...(signal ? { signal } : {}),
        });
        const { run_ms: _drop, ...rest } = stats as unknown as Record<string, unknown>;
        return {
          ticksAtWalkEnd,
          stats: rest,
          chunkState: [...preloadChunkState(v.db, v.id)].sort(([a], [b]) => a.localeCompare(b)),
        };
      } finally {
        turns.stop();
      }
    } finally {
      v.cleanup();
    }
  };

  it("runs event-loop turns while the vault is being walked", async () => {
    const r = await run(300, new AbortController().signal, false);
    expect(r.ticksAtWalkEnd).toBeGreaterThan(0);
  });

  it("keeps the walk synchronous without a signal", async () => {
    const r = await run(300, undefined, false);
    expect(r.ticksAtWalkEnd).toBe(0);
  });

  it("sees the same notes, chunks and stats with and without a signal", async () => {
    for (const warm of [false, true]) {
      const plain = await run(150, undefined, warm);
      const signaled = await run(150, new AbortController().signal, warm);
      expect(signaled.stats).toEqual(plain.stats);
      expect(signaled.chunkState).toEqual(plain.chunkState);
    }
  });
});

describe("cooperative walk and preload equal their synchronous forms", { timeout: 60_000 }, () => {
  it("preloadChunkStateCooperative matches preloadChunkState and takes turns", async () => {
    const v = makeM2Vault({ files: fixtureFiles(300) });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      await indexVault({
        db: v.db,
        provider,
        vaultId: v.id,
        root: v.root,
        isReadable: () => true,
        representation: buildRepresentationManifest(provider, {}),
      });
      const turns = countTurns();
      try {
        const sync = preloadChunkState(v.db, v.id);
        expect(turns.count()).toBe(0);
        const coop = await preloadChunkStateCooperative(
          v.db,
          v.id,
          createLoopYielder(new AbortController().signal, 1),
          7,
        );
        expect(turns.count()).toBeGreaterThan(1);
        expect(coop.size).toBe(sync.size);
        expect(sync.size).toBeGreaterThan(100);
        for (const [path, rows] of sync) expect(coop.get(path)).toEqual(rows);
      } finally {
        turns.stop();
      }
    } finally {
      v.cleanup();
    }
  });

  it("walkVault is untouched: dot-dirs hidden, whole-path order", () => {
    const v = makeM2Vault({ files: fixtureFiles(5) });
    try {
      const rel = walkVault(v.root, { extensions: [".md"] }).map((e) => e.relPath);
      expect(rel).toEqual([...rel].sort((a, b) => a.localeCompare(b)));
      expect(rel).not.toContain(".hidden/x.md");
    } finally {
      v.cleanup();
    }
  });
});
