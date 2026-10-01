// GH #995 follow-up: measures the commit-time cost the write-fence check (note_write_fence +
// index_leader_epoch) adds to an indexVault pass over 1000 notes. "before" provisions the full
// migration chain then DROPS both new tables (hasNoteWriteFence/hasIndexLeaderEpoch fall back to
// their pre-migration no-op path, exactly as a not-yet-migrated cache.db would); "after" leaves
// them in place. Reported, not tightly gated — embed()/walk cost dwarfs one extra indexed PK
// read+upsert per note, and pinning CI to a noisy exact timing would be its own maintenance cost
// (see the repo's perf-gate blind-spot note); the generous ceiling below only catches something
// turning O(n) into O(n^2) or network-shaped.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const N = 1000;

function makeVault(prefix: string): string {
  const root = makeTempDir(prefix);
  for (let i = 0; i < N; i++) {
    writeFileSync(join(root, `note-${i}.md`), `# Note ${i}\nSome body content for note ${i}.\n`);
  }
  return root;
}

describe("write-fence commit-cost perf (GH #995 follow-up)", () => {
  it(`adds negligible overhead to a ${N}-note indexVault pass`, async () => {
    const provider = fakeEmbeddingProvider({ dimensions: 8 });

    const rootBefore = makeVault("obtc-perf-before-");
    const dbBefore = openMemoryDb();
    provisionCacheDb(dbBefore);
    // Simulate a pre-20260928 cache.db: the fence tables absent, write-fence.ts/leader-epoch.ts
    // fall back to their no-op path (hasNoteWriteFence/hasIndexLeaderEpoch -> false).
    dbBefore.exec("DROP TABLE IF EXISTS note_write_fence");
    dbBefore.exec("DROP TABLE IF EXISTS index_leader_epoch");
    const repBefore = buildRepresentationManifest(provider, {});
    const t0 = performance.now();
    const statsBefore = await indexVault({
      db: dbBefore,
      provider,
      vaultId: "v1",
      root: rootBefore,
      isReadable: () => true,
      now: () => 1,
      representation: repBefore,
      chunkContext: false,
    });
    const beforeMs = performance.now() - t0;

    const rootAfter = makeVault("obtc-perf-after-");
    const dbAfter = openMemoryDb();
    provisionCacheDb(dbAfter);
    const repAfter = buildRepresentationManifest(provider, {});
    const t1 = performance.now();
    const statsAfter = await indexVault({
      db: dbAfter,
      provider,
      vaultId: "v1",
      root: rootAfter,
      isReadable: () => true,
      now: () => 1,
      representation: repAfter,
      chunkContext: false,
    });
    const afterMs = performance.now() - t1;

    expect(statsBefore.notes_indexed).toBe(N);
    expect(statsAfter.notes_indexed).toBe(N);

    const overheadPct = ((afterMs - beforeMs) / beforeMs) * 100;
    // Printed for the report this ticket asks for — not asserted on precisely (see header).
    process.stderr.write(
      `[perf] write-fence commit cost on ${N} notes: before=${beforeMs.toFixed(1)}ms ` +
        `after=${afterMs.toFixed(1)}ms overhead=${overheadPct.toFixed(1)}%\n`,
    );
    rmTemp(rootBefore);
    rmTemp(rootAfter);
    expect(afterMs).toBeLessThan(beforeMs * 3 + 500);
    // Two full 1000-note passes: ~1 s each on an idle core, 2-7 s each under load, which is
    // past vitest's 5 s default (17 of 20 runs timed out beside a `tsc` loop, none on the ratio).
  }, 60_000);
});
