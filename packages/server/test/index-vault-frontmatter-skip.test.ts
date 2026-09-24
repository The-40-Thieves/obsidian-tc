// THE-1073 — indexVault's per-note skip-and-warn on invalid frontmatter YAML.
//
// Production incident (Cave, 2026-09-06..15): a single note with unparseable YAML frontmatter made
// parseNote (vault/frontmatter.ts) throw out of processNote, which escaped indexVault entirely —
// plane-wiring.ts's reconcile mapped the WHOLE pass to one health error, and no note in the pass
// was written. 17 notes sat unindexed for nine days while notes_ready stayed true. These tests pin
// the fix: a frontmatter failure is counted, named, and skipped for THIS note only — every other
// note in the pass still indexes.
import { describe, expect, it } from "vitest";
import { fakeEmbeddingProvider } from "../src/embeddings";
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

/** A Database whose `.prepare()` throws a plain (non-ObsidianTcError, non-YAML) Error the moment a
 *  caller compiles a statement matching `sqlSubstring` — everything else forwards to `target`
 *  unchanged. Used to prove a DB fault inside processNote still rejects the whole pass, unlike a
 *  frontmatter-YAML failure. */
function faultyDbOn(target: any, sqlSubstring: string, message: string): any {
  return new Proxy(target, {
    get(t, prop, _receiver) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (sql.includes(sqlSubstring)) throw new Error(message);
          return t.prepare(sql);
        };
      }
      const val = Reflect.get(t, prop, t);
      return typeof val === "function" ? val.bind(t) : val;
    },
  });
}

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

  it("(e) a non-YAML throw from inside processNote (fault-injected DB) still rejects the whole pass", async () => {
    const v = makeM2Vault({
      files: { "alpha.md": "# Alpha\n\nThe quick brown fox jumps over the lazy dog." },
    });
    try {
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      // noteRowHash (search/fts.ts) runs this exact query inside processNote, after a SUCCESSFUL
      // frontmatter parse — a generic DB failure here is a different class of error entirely, and
      // must propagate exactly as before THE-1073, not be swallowed the way a frontmatter-YAML
      // failure is.
      const faultyDb = faultyDbOn(
        v.db,
        "SELECT content_hash FROM notes WHERE vault_id = ? AND path = ?",
        "db unavailable (fault-injected)",
      );
      await expect(
        indexVault({
          db: faultyDb,
          provider,
          vaultId: v.id,
          root: v.root,
          isReadable: () => true,
          representation: buildRepresentationManifest(provider, {}),
        }),
      ).rejects.toThrow("db unavailable (fault-injected)");
    } finally {
      v.cleanup();
    }
  });
});
