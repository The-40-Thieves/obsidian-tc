// THE-1073 — indexVault's per-note skip-and-warn on invalid frontmatter YAML.
//
// Production incident (Cave, 2026-09-06..15): a single note with unparseable YAML frontmatter made
// parseNote (vault/frontmatter.ts) throw out of processNote, which escaped indexVault entirely —
// plane-wiring.ts's reconcile mapped the WHOLE pass to one health error, and no note in the pass
// was written. 17 notes sat unindexed for nine days while notes_ready stayed true. These tests pin
// the fix: a frontmatter failure is counted, named, and skipped for THIS note only — every other
// note in the pass still indexes.
//
// Fix round 1 (cross-vendor review): a skipped note also lost its OWN wikilink-layer edges (both
// directions) under the original fix, since desiredEdges only ever emits a note's edges from its
// noteLinks entry and a skipped note had none — see (c-edges) below.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { recordIngestStats } from "../src/metrics/ingest-stats";
import { MetricsRecorder } from "../src/metrics/registry";
import { readGeneration } from "../src/search/generation";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { makeM2Vault } from "./m2-helpers";

// Malformed on purpose: an unterminated flow sequence. Matches parseNote's `---\n...\n---` block
// regex (so parseNote reaches YAML.parse at all) but YAML.parse throws on the content.
const BAD_FRONTMATTER = "---\nbad: [1, 2\n---\n# Body\n\nSome content.\n";

const chunkCount = (v: ReturnType<typeof makeM2Vault>, path: string): number =>
  (
    v.db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ? AND path = ?")
      .get(v.id, path) as { n: number }
  ).n;

const noteRowExists = (v: ReturnType<typeof makeM2Vault>, path: string): boolean =>
  (
    v.db
      .prepare("SELECT COUNT(*) AS n FROM notes WHERE vault_id = ? AND path = ?")
      .get(v.id, path) as { n: number }
  ).n > 0;

const edgeRows = (
  v: ReturnType<typeof makeM2Vault>,
): Array<{ source_path: string; target_path: string; edge_type: string; provenance: string }> =>
  v.db
    .prepare(
      "SELECT source_path, target_path, edge_type, provenance FROM vault_edges " +
        "WHERE vault_id = ? AND edge_type IN ('links_to', 'unresolved') ORDER BY source_path, target_path, edge_type",
    )
    .all(v.id) as Array<{
    source_path: string;
    target_path: string;
    edge_type: string;
    provenance: string;
  }>;

// Fix round 1 (LOW, Opus test gap): test (e) below must fault-inject INSIDE processNote's
// try/catch — a fault outside it (the original version used a DB proxy on noteRowHash, which runs
// AFTER the try/catch closes) leaves the narrow isFrontmatterYamlError check unexercised: a
// mutation that made the catch swallow everything would still pass. `parseNoteThrowFor` makes
// parseNote ITSELF throw a plain (non-ObsidianTcError) Error for one path, so the throw happens
// where the real code actually decides whether to swallow or rethrow.
let parseNoteThrowFor: string | null = null;
vi.mock("../src/vault/frontmatter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault/frontmatter")>();
  return {
    ...actual,
    parseNote: (raw: string, path?: string) => {
      if (parseNoteThrowFor !== null && path === parseNoteThrowFor) {
        throw new Error("simulated non-frontmatter parse crash (fault-injected)");
      }
      return actual.parseNote(raw, path);
    },
  };
});

afterEach(() => {
  parseNoteThrowFor = null;
});

describe("indexVault: per-note skip-and-warn on invalid frontmatter YAML (THE-1073)", () => {
  it("(a) one invalid note among three: resolves, 2 indexed, the bad one counted and named", async () => {
    const v = makeM2Vault({
      files: {
        "alpha.md": "# Alpha\n\nThe quick brown fox.",
        "bad.md": BAD_FRONTMATTER,
        "charlie.md": "# Charlie\n\nPack my box with jugs.",
      },
    });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      const stats = await indexVault({
        db: v.db,
        provider,
        vaultId: v.id,
        root: v.root,
        isReadable: () => true,
        representation: buildRepresentationManifest(provider, {}),
      });
      expect(stats.notes_frontmatter_failed).toBe(1);
      expect(stats.frontmatter_failures).toHaveLength(1);
      expect(stats.frontmatter_failures[0]?.path).toBe("bad.md");
      expect(stats.frontmatter_failures[0]?.error).toContain("frontmatter is not valid YAML");
      // The other two notes still indexed — the whole pass did not veto for one bad note.
      expect(noteRowExists(v, "alpha.md")).toBe(true);
      expect(noteRowExists(v, "charlie.md")).toBe(true);
      expect(chunkCount(v, "alpha.md")).toBeGreaterThan(0);
      expect(chunkCount(v, "charlie.md")).toBeGreaterThan(0);
      // The bad note itself was never indexed.
      expect(noteRowExists(v, "bad.md")).toBe(false);
      expect(chunkCount(v, "bad.md")).toBe(0);
    } finally {
      v.cleanup();
    }
  });

  it("(b) two invalid notes: both listed, in walk order", async () => {
    const v = makeM2Vault({
      files: {
        "alpha-bad.md": BAD_FRONTMATTER,
        "beta-bad.md": BAD_FRONTMATTER,
        "gamma-good.md": "# Gamma\n\nGood note.",
      },
    });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      const stats = await indexVault({
        db: v.db,
        provider,
        vaultId: v.id,
        root: v.root,
        isReadable: () => true,
        representation: buildRepresentationManifest(provider, {}),
      });
      expect(stats.notes_frontmatter_failed).toBe(2);
      expect(stats.frontmatter_failures.map((f) => f.path)).toEqual([
        "alpha-bad.md",
        "beta-bad.md",
      ]);
      expect(noteRowExists(v, "gamma-good.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("(c) a note that WAS indexed, then gets invalid frontmatter, keeps its existing rows (not swept as stale)", async () => {
    const v = makeM2Vault({
      files: { "good.md": "# Good\n\nOriginally valid content, long enough to chunk." },
    });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      const args = {
        db: v.db,
        provider,
        vaultId: v.id,
        root: v.root,
        isReadable: () => true,
        representation: buildRepresentationManifest(provider, {}),
      };
      await indexVault(args);
      const chunksBefore = chunkCount(v, "good.md");
      expect(chunksBefore).toBeGreaterThan(0);
      expect(noteRowExists(v, "good.md")).toBe(true);

      // Corrupt the note's frontmatter in place — content on disk changes, but the note must NOT
      // be treated as deleted/stale: it was still walked.
      v.write("good.md", BAD_FRONTMATTER);
      const stats2 = await indexVault(args);

      expect(stats2.notes_frontmatter_failed).toBe(1);
      expect(stats2.frontmatter_failures[0]?.path).toBe("good.md");
      // The PRIOR index state is untouched — not de-indexed as stale.
      expect(chunkCount(v, "good.md")).toBe(chunksBefore);
      expect(noteRowExists(v, "good.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  // Fix round 1 (HIGH, both reviewers): a skipped note is absent from noteLinks (its body was
  // never parsed), and desiredEdges (search/edges.ts) produces a note's OWN forward/reverse/
  // unresolved edges only from its noteLinks entry — so the full-state reconcileVaultEdges DELETED
  // a skipped note's edges even though nothing about its links changed. Reviewer repro: a.md links
  // [[b]] and [[c]] (4 edges: a->b forward, b->a reverse, a->c forward, c->a reverse); break a.md's
  // YAML; re-index -> edges 4 -> 0 under both walks, and the generation bumped for a note whose
  // links never actually changed.
  for (const streaming of [false, true]) {
    it(`(c-edges, streaming=${streaming}) a note's edges survive its own frontmatter breaking, and generation does not bump`, async () => {
      const v = makeM2Vault({
        files: {
          "a.md": "---\ntitle: A\n---\n# A\n\nlinks to [[b]] and [[c]].",
          "b.md": "# B\n\nplain, no links",
          "c.md": "# C\n\nplain, no links",
        },
      });
      try {
        const provider = fakeEmbeddingProvider({ dimensions: 8 });
        const args = {
          db: v.db,
          provider,
          vaultId: v.id,
          root: v.root,
          isReadable: () => true,
          representation: buildRepresentationManifest(provider, {}),
          walk: { streaming },
        };
        await indexVault(args);
        const before = edgeRows(v);
        expect(before).toHaveLength(4); // a->b forward+reverse, a->c forward+reverse
        const generationBefore = readGeneration(v.db, v.id);

        // Break ONLY a.md's frontmatter — its links to b/c are unchanged in the raw text.
        v.write("a.md", "---\ntitle: [A\n---\n# A\n\nlinks to [[b]] and [[c]].");
        const stats = await indexVault(args);

        expect(stats.notes_frontmatter_failed).toBe(1);
        expect(stats.frontmatter_failures[0]?.path).toBe("a.md");
        expect(edgeRows(v)).toEqual(before);
        expect(stats.edges_inserted).toBe(0);
        expect(stats.edges_deleted).toBe(0);
        // Nothing result-affecting changed this pass (a.md's own chunks/note row are untouched —
        // processNote returned before reaching them — and its edges are unchanged too), so the
        // generation bump guard (THE-496) must not fire for an unrelated frontmatter skip.
        expect(readGeneration(v.db, v.id)).toBe(generationBefore);
      } finally {
        v.cleanup();
      }
    });
  }

  it("(d) same as (a) under the streaming walk (walk.streaming: true)", async () => {
    const v = makeM2Vault({
      files: {
        "alpha.md": "# Alpha\n\nThe quick brown fox.",
        "bad.md": BAD_FRONTMATTER,
        "charlie.md": "# Charlie\n\nPack my box with jugs.",
      },
    });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      const stats = await indexVault({
        db: v.db,
        provider,
        vaultId: v.id,
        root: v.root,
        isReadable: () => true,
        representation: buildRepresentationManifest(provider, {}),
        walk: { streaming: true },
      });
      expect(stats.notes_frontmatter_failed).toBe(1);
      expect(stats.frontmatter_failures[0]?.path).toBe("bad.md");
      expect(noteRowExists(v, "alpha.md")).toBe(true);
      expect(noteRowExists(v, "charlie.md")).toBe(true);
      expect(noteRowExists(v, "bad.md")).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("(e) a non-YAML throw INSIDE processNote's try (fault-injected parseNote) still rejects the whole pass", async () => {
    const v = makeM2Vault({
      files: { "alpha.md": "# Alpha\n\nThe quick brown fox jumps over the lazy dog." },
    });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      // parseNote itself throws a plain Error for alpha.md — isFrontmatterYamlError must say
      // false (it is not an ObsidianTcError carrying `details.reason: "frontmatter_yaml"`), so
      // processNote's `if (!isFrontmatterYamlError(e)) throw e;` rethrows it, and the whole pass
      // rejects exactly as it did before THE-1073's skip-and-warn existed.
      parseNoteThrowFor = "alpha.md";
      await expect(
        indexVault({
          db: v.db,
          provider,
          vaultId: v.id,
          root: v.root,
          isReadable: () => true,
          representation: buildRepresentationManifest(provider, {}),
        }),
      ).rejects.toThrow("simulated non-frontmatter parse crash (fault-injected)");
    } finally {
      v.cleanup();
    }
  });

  it("(f) a frontmatter skip feeds obsidian_tc_index_frontmatter_failures_total through recordIngestStats", async () => {
    // Fix round 1 (MEDIUM, Opus): proves the counter is actually FED by a real indexVault pass —
    // not merely registered (see metrics.test.ts's catalog assertion, which only proves
    // registration).
    const v = makeM2Vault({ files: { "bad.md": BAD_FRONTMATTER, "good.md": "# Good\n\nfine" } });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      const stats = await indexVault({
        db: v.db,
        provider,
        vaultId: v.id,
        root: v.root,
        isReadable: () => true,
        representation: buildRepresentationManifest(provider, {}),
      });
      expect(stats.notes_frontmatter_failed).toBe(1);

      const metrics = new MetricsRecorder();
      recordIngestStats(v.db, metrics, v.id, stats);
      const text = await metrics.metrics();
      expect(text).toMatch(
        new RegExp(`obsidian_tc_index_frontmatter_failures_total\\{vault="${v.id}"\\} 1`),
      );
      const row = v.db
        .prepare("SELECT result_size FROM event_log WHERE event_type = 'index_frontmatter_failed'")
        .get() as { result_size: number } | undefined;
      expect(row?.result_size).toBe(1);
    } finally {
      v.cleanup();
    }
  });
});
