// Obsidian's Excluded files, applied to the index: an excluded note is not indexed (no chunks, no
// vectors, no FTS/notes row, no graph edge, nothing sent to the embedding provider) and never comes
// back from a search tool, but it stays an ordinary vault file: links to it resolve, read_note works
// and the ACL is untouched. Becoming excluded de-indexes (dismissing its open contradiction rows with
// a reason); un-excluding re-indexes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FolderAcl } from "../src/acl";
import type { EmbeddingProvider } from "../src/embeddings";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { MetricsRecorder } from "../src/metrics/registry";
import type { IndexHealthState } from "../src/runtime/indexing-wiring";
import { wireIndexCoordinator } from "../src/runtime/indexing-wiring";
import { desiredEdges } from "../src/search/edges";
import { EXCLUDED_DISMISS_REASON, vaultExclusionFor } from "../src/search/index-exclusion";
import { upsertNoteSummary } from "../src/search/note-summaries";
import { extractLinks } from "../src/vault/links";
import { makeTestVault } from "./m1-helpers";
import { type M2Vault, makeM2Vault } from "./m2-helpers";

const APP = ".obsidian/app.json";
const setExcluded = (v: { root: string }, entries: string[]): void => {
  mkdirSync(join(v.root, ".obsidian"), { recursive: true });
  writeFileSync(join(v.root, APP), JSON.stringify({ userIgnoreFilters: entries }));
};

const FILES = {
  "Projects/plan.md": "# Plan\n\nThe zebra roadmap. See [[Old decision]] and [[Gone]].\n",
  "Archive/Old decision.md":
    "# Old decision\n\nThe zebra archive keeps ARCHIVEWORD notes. Back to [[plan]].\n",
  "Notes/scratch.draft.md": "# Scratch\n\nA zebra DRAFTWORD scratch pad.\n",
  "Notes/keep.md": "# Keep\n\nA zebra note that stays searchable.\n",
};

/** A fake provider that records every text it is asked to embed. */
function spyProvider(): { provider: EmbeddingProvider; seen: string[] } {
  const base = fakeEmbeddingProvider({ dimensions: 32 });
  const seen: string[] = [];
  const provider: EmbeddingProvider = {
    ...base,
    embed: async (texts, opts) => {
      seen.push(...texts);
      return base.embed(texts, opts);
    },
  };
  return { provider, seen };
}

const count = (v: M2Vault, sql: string, ...args: unknown[]): number =>
  (v.db.prepare(sql).get(...args) as { n: number }).n;
const chunkPaths = (v: M2Vault): string[] =>
  (
    v.db.prepare("SELECT DISTINCT path FROM chunks WHERE vault_id = ? ORDER BY path").all(v.id) as {
      path: string;
    }[]
  ).map((r) => r.path);
const noteRows = (v: M2Vault): string[] =>
  (
    v.db.prepare("SELECT path FROM notes WHERE vault_id = ? ORDER BY path").all(v.id) as {
      path: string;
    }[]
  ).map((r) => r.path);
const edges = (
  v: M2Vault,
): Array<{ source_path: string; target_path: string; edge_type: string }> =>
  v.db
    .prepare("SELECT source_path, target_path, edge_type FROM vault_edges WHERE vault_id = ?")
    .all(v.id) as never;
const hitPaths = (r: { ok: boolean; data?: unknown }): string[] => {
  const d = r.data as { items?: Array<{ path: string }>; hits?: Array<{ path: string }> };
  return (d.items ?? d.hits ?? []).map((h) => h.path);
};

describe("an excluded note is not indexed", () => {
  it("has no chunks, vectors, notes/FTS row or graph edge, and its text never reaches the embedder", async () => {
    const { provider, seen } = spyProvider();
    const v = makeM2Vault({ files: FILES, provider });
    try {
      setExcluded(v, ["Archive/", "/\\.draft\\.md$/"]);
      const r = await v.call("index_vault", { vault: v.id });
      expect(r.ok).toBe(true);

      expect(chunkPaths(v)).toEqual(["Notes/keep.md", "Projects/plan.md"]);
      expect(noteRows(v)).toEqual(["Notes/keep.md", "Projects/plan.md"]);
      expect(
        count(
          v,
          "SELECT COUNT(*) AS n FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE c.path IN ('Archive/Old decision.md','Notes/scratch.draft.md')",
        ),
      ).toBe(0);
      // The embedding provider was never handed any text of an excluded note.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.some((t) => t.includes("ARCHIVEWORD") || t.includes("DRAFTWORD"))).toBe(false);
      expect(seen.some((t) => t.includes("roadmap"))).toBe(true);
      // The graph layer omits them, like Obsidian's Graph view: no edge touches an excluded note,
      // and a link to one is not recorded as unresolved either.
      for (const e of edges(v)) {
        expect(e.source_path).not.toMatch(/^Archive\/|\.draft\.md$/);
        if (e.edge_type === "links_to")
          expect(e.target_path).not.toMatch(/^Archive\/|\.draft\.md$/);
      }
      expect(
        edges(v).some((e) => e.edge_type === "unresolved" && e.target_path === "Old decision"),
      ).toBe(false);
      // ...while a genuinely dangling link still is.
      expect(edges(v).some((e) => e.edge_type === "unresolved" && e.target_path === "Gone")).toBe(
        true,
      );
    } finally {
      v.cleanup();
    }
  });

  it("never comes back from a search tool, on any leg", async () => {
    const v = makeM2Vault({ files: FILES });
    try {
      setExcluded(v, ["Archive/", "/\\.draft\\.md$/"]);
      await v.call("index_vault", { vault: v.id });
      const legs: Array<[string, Record<string, unknown>]> = [
        ["search_text", { vault: v.id, query: "zebra" }],
        ["search_regex", { vault: v.id, pattern: "zebra" }],
        ["search_semantic", { vault: v.id, query: "zebra archive keeps notes" }],
        ["search_jsonlogic", { vault: v.id, logic: { in: ["zebra", { var: "content" }] } }],
        ["search_vault", { vault: v.id, query: "zebra", mode: "text" }],
      ];
      for (const [tool, input] of legs) {
        const r = await v.call(tool, input);
        expect(r.ok, `${tool}: ${JSON.stringify(r)}`).toBe(true);
        const paths = hitPaths(r);
        expect(paths.length, `${tool} found nothing`).toBeGreaterThan(0);
        expect(paths.join("|"), tool).not.toMatch(/Archive\/|\.draft\.md/);
      }
    } finally {
      v.cleanup();
    }
  });

  it("is also cut at search time when a stale index row survives (filesystem legs and DB legs)", async () => {
    const v = makeM2Vault({ files: FILES });
    try {
      // Index everything first, THEN exclude without re-indexing: the rows are stale, the tool must
      // still not return them.
      await v.call("index_vault", { vault: v.id });
      expect(chunkPaths(v)).toContain("Archive/Old decision.md");
      setExcluded(v, ["Archive/"]);
      for (const [tool, input] of [
        ["search_text", { vault: v.id, query: "zebra" }],
        ["search_regex", { vault: v.id, pattern: "zebra" }],
        ["search_semantic", { vault: v.id, query: "zebra archive keeps notes" }],
      ] as Array<[string, Record<string, unknown>]>) {
        const r = await v.call(tool, input);
        expect(hitPaths(r).join("|"), tool).not.toContain("Archive/");
      }
    } finally {
      v.cleanup();
    }
  });

  it("the streaming walk excludes identically", async () => {
    const { provider, seen } = spyProvider();
    const v = makeM2Vault({ files: FILES, provider, streamingWalk: true });
    try {
      setExcluded(v, ["Archive/"]);
      await v.call("index_vault", { vault: v.id });
      expect(chunkPaths(v)).not.toContain("Archive/Old decision.md");
      expect(seen.some((t) => t.includes("ARCHIVEWORD"))).toBe(false);
    } finally {
      v.cleanup();
    }
  });
});

describe("an excluded note is still a normal vault file", () => {
  const withApp = (extra: Record<string, string> = {}) =>
    makeTestVault({
      files: {
        ...FILES,
        ...extra,
        [APP]: JSON.stringify({ userIgnoreFilters: ["Archive/"] }),
      },
    });

  it("links to it resolve, backlinks and outgoing links still show the edges, read_note works", async () => {
    const v = withApp();
    try {
      const ok = (r: { ok: boolean; data?: unknown; error?: unknown }): Record<string, any> => {
        if (!r.ok) throw new Error(JSON.stringify(r.error));
        return r.data as Record<string, any>;
      };
      const unresolved = ok(await v.call("find_unresolved_links", { vault: "test" }));
      expect(JSON.stringify(unresolved)).not.toContain("Old decision");
      expect(JSON.stringify(unresolved)).toContain("Gone"); // a real dangling link still shows
      const back = ok(
        await v.call("get_backlinks", { vault: "test", path: "Archive/Old decision.md" }),
      );
      expect(JSON.stringify(back)).toContain("Projects/plan.md");
      const out = ok(
        await v.call("get_outgoing_links", { vault: "test", path: "Archive/Old decision.md" }),
      );
      expect(JSON.stringify(out)).toContain("Projects/plan.md");
      const read = ok(
        await v.call("read_note", { vault: "test", path: "Archive/Old decision.md" }),
      );
      expect(String(read.content)).toContain("ARCHIVEWORD");
    } finally {
      v.cleanup();
    }
  });

  it("desiredEdges resolves the link (universe) but emits no edge for the excluded note", () => {
    const links = new Map([
      ["Projects/plan.md", extractLinks("See [[Old decision]] and [[keep]].")],
    ]);
    const universe = ["Projects/plan.md", "Archive/Old decision.md", "Notes/keep.md"];
    const all = desiredEdges(links, universe);
    expect(all.some((e) => e.target_path === "Archive/Old decision.md")).toBe(true);
    const cut = desiredEdges(links, universe, new Set(["Archive/Old decision.md"]));
    expect(
      cut.some((e) => e.source_path.startsWith("Archive/") || e.target_path.startsWith("Archive/")),
    ).toBe(false);
    expect(cut.some((e) => e.edge_type === "unresolved")).toBe(false);
    expect(cut.some((e) => e.target_path === "Notes/keep.md")).toBe(true);
  });

  it("the ACL is unchanged: an excluded note is readable where the ACL allows, and an ACL-hidden note stays hidden", async () => {
    const v = makeM2Vault({
      files: { ...FILES, "Secret/hidden.md": "# Hidden\n\nA zebra note behind the ACL.\n" },
      acl: { rules: [{ glob: "Secret/**", scopes: ["read:secret"] }] },
    });
    try {
      setExcluded(v, ["Archive/"]);
      // Same readable predicate as before for non-excluded paths: the ACL-hidden note is not searchable...
      const r = await v.call(
        "search_regex",
        { vault: v.id, pattern: "zebra" },
        { grantedScopes: new Set(["read:notes"]) },
      );
      expect(r.ok).toBe(true);
      expect(hitPaths(r).join("|")).not.toContain("Secret/");
      // ...and exclusion is an addition to it, never a replacement: the plain note is still found.
      expect(hitPaths(r)).toContain("Notes/keep.md");
    } finally {
      v.cleanup();
    }
  });
});

describe("transitions", () => {
  it("does not seed embedding dedup from a path excluded in the same reconcile", async () => {
    const body = "# Same\n\nidentical semantic body\n";
    const v = makeM2Vault({ files: { "a.md": body } });
    try {
      expect((await v.call("index_vault", { vault: v.id })).ok).toBe(true);
      writeFileSync(join(v.root, "z.md"), body);
      setExcluded(v, ["a.md"]);

      const reconciled = await v.call("index_vault", { vault: v.id });
      expect(reconciled.ok).toBe(true);
      if (reconciled.ok)
        expect(
          (reconciled.data as { chunks_dedup_unresolved: number }).chunks_dedup_unresolved,
        ).toBe(0);
      expect(chunkPaths(v)).toEqual(["z.md"]);
      expect(
        count(
          v,
          "SELECT COUNT(*) AS n FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE c.vault_id = ? AND c.path = 'z.md' AND e.is_active = 1",
          v.id,
        ),
      ).toBeGreaterThan(0);
      const found = await v.call("search_semantic", {
        vault: v.id,
        query: "identical semantic body",
      });
      expect(hitPaths(found)).toContain("z.md");
    } finally {
      v.cleanup();
    }
  });

  it("a note that becomes excluded is de-indexed and its open contradictions are dismissed with a reason; un-excluding re-indexes", async () => {
    const { provider, seen } = spyProvider();
    const v = makeM2Vault({ files: FILES, provider });
    try {
      await v.call("index_vault", { vault: v.id });
      expect(chunkPaths(v)).toContain("Archive/Old decision.md");
      expect(noteRows(v)).toContain("Archive/Old decision.md");
      const archChunk = v.db
        .prepare("SELECT id FROM chunks WHERE vault_id = ? AND path = ?")
        .get(v.id, "Archive/Old decision.md") as { id: string };
      const planChunk = v.db
        .prepare("SELECT id FROM chunks WHERE vault_id = ? AND path = ?")
        .get(v.id, "Projects/plan.md") as { id: string };
      const insertContradiction = v.db.prepare(
        `INSERT INTO contradictions (id, source_chunk_id, source_path, conflict_chunk_id, conflict_path,
           source_content_sha, conflict_content_sha, judge_verdict, status, detected_at, vault_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'contradiction', ?, 1, ?)`,
      );
      insertContradiction.run(
        "c-open",
        archChunk.id,
        "Archive/Old decision.md",
        planChunk.id,
        "Projects/plan.md",
        "s1",
        "s2",
        "open",
        v.id,
      );
      insertContradiction.run(
        "c-other",
        planChunk.id,
        "Projects/plan.md",
        planChunk.id,
        "Projects/plan.md",
        "s3",
        "s4",
        "open",
        v.id,
      );
      upsertNoteSummary(v.db, v.id, {
        path: "Archive/Old decision.md",
        contentHash: "h",
        summary: "s",
        model: "m",
        createdAt: 1,
      });

      setExcluded(v, ["Archive/"]);
      const before = seen.length;
      await v.call("index_vault", { vault: v.id });
      expect(chunkPaths(v)).not.toContain("Archive/Old decision.md");
      expect(noteRows(v)).not.toContain("Archive/Old decision.md");
      expect(
        count(
          v,
          "SELECT COUNT(*) AS n FROM note_summaries WHERE path = ?",
          "Archive/Old decision.md",
        ),
      ).toBe(0);
      const row = v.db
        .prepare(
          "SELECT status, resolution_reason, resolved_at FROM contradictions WHERE id = 'c-open'",
        )
        .get() as {
        status: string;
        resolution_reason: string;
        resolved_at: number;
      };
      expect(row.status).toBe("dismissed");
      expect(row.resolution_reason).toBe(EXCLUDED_DISMISS_REASON);
      expect(row.resolved_at).toBeGreaterThan(0);
      // A row that does not involve the excluded note is untouched.
      expect(
        (
          v.db.prepare("SELECT status FROM contradictions WHERE id = 'c-other'").get() as {
            status: string;
          }
        ).status,
      ).toBe("open");
      expect(seen.slice(before).some((t) => t.includes("ARCHIVEWORD"))).toBe(false);

      // A steady-state pass changes nothing and is idempotent.
      await v.call("index_vault", { vault: v.id });
      expect(chunkPaths(v)).not.toContain("Archive/Old decision.md");

      // Un-exclude: it is indexed again, and its text reaches the embedder again.
      setExcluded(v, []);
      await v.call("index_vault", { vault: v.id });
      expect(chunkPaths(v)).toContain("Archive/Old decision.md");
      expect(noteRows(v)).toContain("Archive/Old decision.md");
      expect(seen.slice(before).some((t) => t.includes("ARCHIVEWORD"))).toBe(true);
      expect(edges(v).some((e) => e.target_path === "Archive/Old decision.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("index-on-write: an excluded path is never embedded on write and a leftover is removed; other paths index normally", async () => {
    const { provider, seen } = spyProvider();
    const v = makeM2Vault({ files: FILES, provider });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const health: IndexHealthState = {
        reconcile: "ok",
        reconcileAt: 0,
        reconcileErrors: [],
        writeFailures: 0,
        frontmatterFailures: new Map(),
        notesReady: true,
        auditWriteFailures: 0,
        indexQueueBackpressures: 0,
        lastChunksUpserted: null,
        inFlight: null,
      };
      const wiring = wireIndexCoordinator({
        db: v.db,
        metrics: new MetricsRecorder(),
        embeddingProvider: provider,
        hasVec: false,
        chunkContext: false,
        indexing: { writeConcurrency: 2, writeConcurrencyPerVault: 2, queueMax: 100 },
        vaults: [],
        watch: { enabled: false, debounceMs: 0 },
        sqlHooksFor: () => ({}),
        indexHealth: health,
        acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
        aclByVault: new Map(),
        makeOnIndexed: () => undefined,
        indexExclusionFor: (id) => vaultExclusionFor(v.vaultRegistry, id),
      });
      // Indexed before it was excluded...
      wiring.reindexHook(v.id, "Archive/Old decision.md", FILES["Archive/Old decision.md"]);
      await wiring.indexCoordinator.idle();
      expect(chunkPaths(v)).toContain("Archive/Old decision.md");
      // ...then excluded: the next write removes the leftover and embeds nothing.
      setExcluded(v, ["Archive/"]);
      const before = seen.length;
      wiring.reindexHook(
        v.id,
        "Archive/Old decision.md",
        "# Old decision\n\nNEWARCHIVEWORD text.\n",
      );
      wiring.reindexHook(v.id, "Notes/keep.md", "# Keep\n\nFresh KEEPWORD text.\n");
      await wiring.indexCoordinator.idle();
      expect(chunkPaths(v)).not.toContain("Archive/Old decision.md");
      expect(chunkPaths(v)).toContain("Notes/keep.md");
      const fresh = seen.slice(before).join("\n");
      expect(fresh).toContain("KEEPWORD");
      expect(fresh).not.toContain("NEWARCHIVEWORD");
      expect(health.writeFailures).toBe(0);
    } finally {
      stderr.mockRestore();
      v.cleanup();
    }
  });
});
