// THE-645: indexVault's onProgress seam — fired once per completed flush() batch (never per note,
// never per chunk, per the perf-gate constraint documented on IndexVaultArgs.onProgress:
// index.chunks_per_s is a gated metric, so a per-chunk callback is explicitly ruled out), carrying
// cumulative notes-processed/chunks-upserted counts and a startedAt pinned to the top of the run.
// Watched failing before landing the callback, per this repo's own testing convention.
import { describe, expect, it } from "vitest";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { makeM2Vault } from "./m2-helpers";

interface ProgressEvent {
  notesSeen: number;
  notesProcessed: number;
  chunksUpserted: number;
  startedAt: number;
}

describe("indexVault onProgress (THE-645)", () => {
  it("fires once per completed flush() batch, not once per note overall", async () => {
    const v = makeM2Vault({
      files: {
        "a.md": "alpha content one",
        "b.md": "bravo content two",
        "c.md": "charlie content three",
      },
    });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      const events: ProgressEvent[] = [];
      const stats = await indexVault({
        db: v.db,
        provider,
        vaultId: v.id,
        root: v.root,
        isReadable: () => true,
        representation: buildRepresentationManifest(provider, {}),
        batch: { maxNotes: 1 }, // force one flush per note
        onProgress: (p) => events.push(p),
      });
      // Three notes, batch size 1 -> exactly one flush per note -> exactly 3 firings.
      expect(events.length).toBe(3);
      expect(events.at(-1)?.chunksUpserted).toBe(stats.chunks_upserted);
      expect(events.at(-1)?.notesProcessed).toBe(stats.notes_indexed);
    } finally {
      v.cleanup();
    }
  });

  it("does not fire per chunk — a single multi-chunk note still yields exactly one event", async () => {
    // Comfortably over the chunker's 512-token default budget, so this note splits into several
    // chunks — proving the cadence is flush-based, not chunk-based (a per-chunk callback would
    // fire more than once here even though there is only ever one note, one flush).
    const bigNote = Array.from(
      { length: 40 },
      (_, i) => `Paragraph ${i} ${"lorem ipsum dolor sit amet ".repeat(20)}`,
    ).join("\n\n");
    const v = makeM2Vault({ files: { "big.md": bigNote } });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      const events: ProgressEvent[] = [];
      const stats = await indexVault({
        db: v.db,
        provider,
        vaultId: v.id,
        root: v.root,
        isReadable: () => true,
        representation: buildRepresentationManifest(provider, {}),
        onProgress: (p) => events.push(p),
      });
      expect(stats.chunks_upserted).toBeGreaterThan(1);
      expect(events.length).toBe(1);
      expect(events[0]?.chunksUpserted).toBe(stats.chunks_upserted);
    } finally {
      v.cleanup();
    }
  });

  it("reports cumulative counts across multiple flushes, monotonically non-decreasing", async () => {
    const v = makeM2Vault({
      files: { "a.md": "alpha one", "b.md": "bravo two", "c.md": "charlie three" },
    });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      const events: ProgressEvent[] = [];
      await indexVault({
        db: v.db,
        provider,
        vaultId: v.id,
        root: v.root,
        isReadable: () => true,
        representation: buildRepresentationManifest(provider, {}),
        batch: { maxNotes: 1 },
        onProgress: (p) => events.push(p),
      });
      expect(events.length).toBe(3);
      for (let i = 1; i < events.length; i++) {
        expect(events[i]?.notesProcessed).toBeGreaterThanOrEqual(
          events[i - 1]?.notesProcessed ?? 0,
        );
        expect(events[i]?.chunksUpserted).toBeGreaterThanOrEqual(
          events[i - 1]?.chunksUpserted ?? 0,
        );
      }
      expect(events.at(-1)?.notesProcessed).toBe(3);
    } finally {
      v.cleanup();
    }
  });

  it("reports notesSeen as the walk total under the default (eager) walk", async () => {
    const v = makeM2Vault({ files: { "a.md": "alpha", "b.md": "bravo" } });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      const events: ProgressEvent[] = [];
      await indexVault({
        db: v.db,
        provider,
        vaultId: v.id,
        root: v.root,
        isReadable: () => true,
        representation: buildRepresentationManifest(provider, {}),
        onProgress: (p) => events.push(p),
      });
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) expect(e.notesSeen).toBe(2);
    } finally {
      v.cleanup();
    }
  });

  it("reports notesSeen as -1 (unknown) under the streaming walk", async () => {
    const v = makeM2Vault({ files: { "a.md": "alpha", "b.md": "bravo" } });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      const events: ProgressEvent[] = [];
      await indexVault({
        db: v.db,
        provider,
        vaultId: v.id,
        root: v.root,
        isReadable: () => true,
        representation: buildRepresentationManifest(provider, {}),
        walk: { streaming: true },
        onProgress: (p) => events.push(p),
      });
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) expect(e.notesSeen).toBe(-1);
    } finally {
      v.cleanup();
    }
  });

  it("pins startedAt to the top of the run — identical across every batch's event", async () => {
    const v = makeM2Vault({
      files: { "a.md": "alpha", "b.md": "bravo", "c.md": "charlie" },
    });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      const events: ProgressEvent[] = [];
      let tick = 1_700_000_000_000;
      await indexVault({
        db: v.db,
        provider,
        vaultId: v.id,
        root: v.root,
        isReadable: () => true,
        representation: buildRepresentationManifest(provider, {}),
        batch: { maxNotes: 1 },
        now: () => tick++,
        onProgress: (p) => events.push(p),
      });
      expect(events.length).toBe(3);
      const first = events[0]?.startedAt;
      expect(events.every((e) => e.startedAt === first)).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("absent onProgress changes no behavior — stats are identical to the callback-present case", async () => {
    const files = { "a.md": "alpha content", "b.md": "bravo content" };
    const vNoCb = makeM2Vault({ files, vaultId: "v1" });
    const vWithCb = makeM2Vault({ files, vaultId: "v1" });
    try {
      const providerA = fakeEmbeddingProvider({ dimensions: 8 });
      const providerB = fakeEmbeddingProvider({ dimensions: 8 });
      const now = (): number => 1_700_000_000_000;
      const statsNoCb = await indexVault({
        db: vNoCb.db,
        provider: providerA,
        vaultId: vNoCb.id,
        root: vNoCb.root,
        isReadable: () => true,
        representation: buildRepresentationManifest(providerA, {}),
        now,
      });
      const statsWithCb = await indexVault({
        db: vWithCb.db,
        provider: providerB,
        vaultId: vWithCb.id,
        root: vWithCb.root,
        isReadable: () => true,
        representation: buildRepresentationManifest(providerB, {}),
        now,
        onProgress: () => {},
      });
      expect(statsWithCb).toEqual(statsNoCb);
    } finally {
      vNoCb.cleanup();
      vWithCb.cleanup();
    }
  });
});
