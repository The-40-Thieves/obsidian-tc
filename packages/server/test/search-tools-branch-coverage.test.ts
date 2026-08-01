// THE-602: closes uncovered branches in src/tools/m2/search-tools.ts (v8 AST-aware branch
// coverage under vitest 4). Every case here asserts genuine behavior — a real hit set, a thrown
// error code, or a logged field — never a bare "it ran" execution.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { type EmbeddingProvider, fakeEmbeddingProvider } from "../src/embeddings";
import type { RetrievalLogEvent } from "../src/experiential/log";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { buildRepresentationManifest } from "../src/search/representation";
import { registerM2Tools } from "../src/tools/m2";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeM2Vault } from "./m2-helpers";
import { rmTemp } from "./tmp";

function payload(res: ToolResult): any {
  if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
  return res.data;
}

/**
 * A second, independent M2 harness (mirrors m2-helpers.ts's makeM2Vault) for the handful of
 * branches that need deps the shared fixture deliberately doesn't expose (metadataIndex,
 * retrievalLog). Added here rather than widening m2-helpers.ts, which other in-flight test files
 * in this worktree are concurrently using.
 */
function makeCustomVault(opts: {
  files?: Record<string, string>;
  acl?: Partial<AclConfigT>;
  metadataIndex?: { hasFts: boolean; ready: () => boolean };
  retrievalLog?: (e: RetrievalLogEvent) => void;
}) {
  const root = mkdtempSync(join(tmpdir(), "obtc-m2-branch-"));
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const db = openMemoryDb();
  provisionCacheDb(db);
  const aclCfg: AclConfigT = { readOnly: false, defaultScopes: [], rules: [], ...opts.acl };
  const acl = new FolderAcl(aclCfg);
  const vaultRegistry = new VaultRegistry([{ id: "test", path: root }]);
  const registry = new ToolRegistry();
  registerM2Tools(registry, {
    vaultRegistry,
    embeddingProvider: fakeEmbeddingProvider({ dimensions: 32 }),
    representation: buildRepresentationManifest(fakeEmbeddingProvider({ dimensions: 32 }), {}),
    metadataIndex: opts.metadataIndex,
    retrievalLog: opts.retrievalLog,
  });
  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "test",
    db,
    acl,
    ...over,
  });
  return {
    call: (name: string, input: Record<string, unknown>, over?: Partial<CallerContext>) =>
      registry.dispatch(name, input, ctx(over)),
    cleanup: () => rmTemp(root),
  };
}

describe("scope()/underRoot root-folder filtering (line 42, 245-246)", () => {
  // search_semantic's isReadable scan runs over ALL indexed chunks (unlike search_text's
  // directory walk, which never visits an out-of-root file in the first place) — so this is the
  // one search mode where underRoot's branches inside the combined `readable` predicate (line 251)
  // are load-bearing, not redundant with the walk's own directory pre-filter. Also exercises the
  // scope() cond-expr/if at 245-246 (root truthy -> normalizeVaultPath + enforcePathAcl run).
  const files = {
    "keep/a.md": "the lazy dog sleeps under the porch",
    "keep2/b.md": "the lazy dog sleeps under a different porch",
    "leaf.md": "the lazy dog sleeps alone",
  };

  it("a folder root keeps rel.startsWith(sub/) hits and excludes a same-prefix sibling folder", async () => {
    const v = makeM2Vault({ files });
    await v.call("index_vault", { vault: "test" });
    try {
      const d = payload(
        await v.call("search_semantic", { vault: "test", query: "lazy dog", k: 10, root: "keep" }),
      );
      expect(d.items.length).toBeGreaterThan(0);
      expect(d.items.every((i: { path: string }) => i.path === "keep/a.md")).toBe(true);
      expect(d.items.some((i: { path: string }) => i.path === "keep2/b.md")).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("a root equal to a note's own path (rel === sub) keeps only that note", async () => {
    const v = makeM2Vault({ files });
    await v.call("index_vault", { vault: "test" });
    try {
      const d = payload(
        await v.call("search_semantic", {
          vault: "test",
          query: "lazy dog",
          k: 10,
          root: "leaf.md",
        }),
      );
      expect(d.items.length).toBeGreaterThan(0);
      expect(d.items.every((i: { path: string }) => i.path === "leaf.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});

describe("embedQuery's vec ?? [] fallback (line 257)", () => {
  /** A provider that answers a normal document-embed call (so index_vault still works) but
   *  returns NO vector at all for a query-embed call — modeling a provider whose response omits
   *  the single requested embedding (e.g. a filtered/rejected query). embedQuery destructures
   *  `const [vec] = await ...embed(...)`, so this makes `vec` undefined, and `vec ?? []` must
   *  fall back to an empty query vector rather than throwing. */
  function providerThatCannotEmbedQueries(): EmbeddingProvider {
    const base = fakeEmbeddingProvider({ dimensions: 32 });
    return {
      ...base,
      embed: (texts: string[], opts?: { input?: "query" | "document" }) =>
        opts?.input === "query" ? Promise.resolve([]) : base.embed(texts, opts),
    };
  }

  it("search_semantic still returns ok (dimension-tolerant zero-score hits) when the query embed comes back empty", async () => {
    const v = makeM2Vault({
      files: { "a.md": "the quick brown fox jumps over the fence" },
      provider: providerThatCannotEmbedQueries(),
    });
    await v.call("index_vault", { vault: "test" }); // real document embeds -> real chunk vectors
    try {
      const res = await v.call("search_semantic", { vault: "test", query: "fox", k: 5 });
      expect(res.ok).toBe(true);
      const d = payload(res);
      // An empty query vector can't match any dimension, so every real chunk lands in the
      // dimension-mismatched fallback bucket in semantic.ts and scores 0 — genuinely returned,
      // not silently dropped, and the call did not throw despite the missing query vector.
      expect(d.items.length).toBeGreaterThan(0);
      expect(d.items.every((i: { score: number }) => i.score === 0)).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});

describe("search_dql / search_vault(mode:dql) ACL-enumeration guard (line 477, 592)", () => {
  it("search_dql refuses a restricted read ACL with acl_denied before touching the bridge", async () => {
    const v = makeM2Vault({
      files: { "pub/a.md": "x", "priv/b.md": "y" },
      acl: { readPaths: ["pub/**"] },
    });
    try {
      const res = await v.call("search_dql", { vault: "test", dql: "TABLE file.name" });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("acl_denied");
    } finally {
      v.cleanup();
    }
  });

  it("search_vault mode:dql refuses a restricted read ACL with acl_denied before touching the bridge", async () => {
    const v = makeM2Vault({
      files: { "pub/a.md": "x", "priv/b.md": "y" },
      acl: { readPaths: ["pub/**"] },
    });
    try {
      const res = await v.call("search_vault", {
        vault: "test",
        query: "TABLE file.name",
        mode: "dql",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("acl_denied");
    } finally {
      v.cleanup();
    }
  });
});

describe("search_vault: asString/asObject query-shape guards (line 508, 513)", () => {
  it("mode:text with an object query throws invalid_input (asString guard)", async () => {
    const v = makeM2Vault({ files: { "a.md": "hello" } });
    try {
      const res = await v.call("search_vault", {
        vault: "test",
        query: { "==": [1, 1] },
        mode: "text",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("mode:jsonlogic with a string query throws invalid_input (asObject guard)", async () => {
    const v = makeM2Vault({ files: { "a.md": "hello" } });
    try {
      const res = await v.call("search_vault", {
        vault: "test",
        query: "not an object",
        mode: "jsonlogic",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });
});

describe("search_vault explicit mode dispatch (switch arms, line 547/551/569/573)", () => {
  async function seeded() {
    const v = makeM2Vault({
      files: {
        "fox.md": "a quick brown fox jumps over the fence",
        "dog.md": "# Dog\n\nthe lazy dog sleeps",
      },
    });
    await v.call("index_vault", { vault: "test" });
    return v;
  }

  it("mode:text returns the same hits as search_text", async () => {
    const v = await seeded();
    try {
      const d = payload(
        await v.call("search_vault", { vault: "test", query: "fox", mode: "text" }),
      );
      expect(d.mode_used).toBe("text");
      expect(d.items.map((i: { path: string }) => i.path)).toEqual(["fox.md"]);
    } finally {
      v.cleanup();
    }
  });

  it("mode:regex returns per-match locations", async () => {
    const v = await seeded();
    try {
      const d = payload(
        await v.call("search_vault", { vault: "test", query: "la\\w+", mode: "regex" }),
      );
      expect(d.mode_used).toBe("regex");
      expect(d.items[0].path).toBe("dog.md");
      expect(d.items[0].snippet).toContain("lazy");
    } finally {
      v.cleanup();
    }
  });

  it("mode:semantic returns top-k chunks directly (bypassing the text-first auto route)", async () => {
    const v = await seeded();
    try {
      const d = payload(
        await v.call("search_vault", { vault: "test", query: "lazy dog", mode: "semantic" }),
      );
      expect(d.mode_used).toBe("semantic");
      expect(d.items.length).toBeGreaterThan(0);
      expect(d.items[0]).toHaveProperty("chunk_id");
    } finally {
      v.cleanup();
    }
  });

  it("mode:jsonlogic filters by frontmatter directly", async () => {
    const v = makeM2Vault({
      files: {
        "task.md": "---\nstatus: active\n---\n\n# Task\n\nship it",
        "other.md": "---\nstatus: done\n---\n\n# Other\n\nfinished",
      },
    });
    await v.call("index_vault", { vault: "test" });
    try {
      const d = payload(
        await v.call("search_vault", {
          vault: "test",
          query: { "==": [{ var: "status" }, "active"] },
          mode: "jsonlogic",
        }),
      );
      expect(d.mode_used).toBe("jsonlogic");
      // search_vault's jsonlogic arm returns UnifiedHit shape (path/score/mode_used) — distinct
      // from the standalone search_jsonlogic tool's {path, matched:true} output contract.
      expect(d.items).toEqual([{ path: "task.md", score: 1, mode_used: "jsonlogic" }]);
    } finally {
      v.cleanup();
    }
  });
});

describe("semantic() retrieval-log nullish coalescing (line 291-292)", () => {
  it("logs sessionId/caller as null when absent, and as the real value when present", async () => {
    const events: RetrievalLogEvent[] = [];
    const v = makeCustomVault({
      files: { "a.md": "the quick brown fox" },
      retrievalLog: (e) => events.push(e),
    });
    try {
      await v.call("index_vault", { vault: "test" });

      // Default ctx from makeCustomVault: no sessionId, caller: "test".
      await v.call("search_semantic", { vault: "test", query: "fox", k: 1 });
      expect(events).toHaveLength(1);
      expect(events[0]?.sessionId).toBeNull();
      expect(events[0]?.caller).toBe("test");

      // Override both to the opposite presence.
      await v.call(
        "search_semantic",
        { vault: "test", query: "fox", k: 1 },
        { sessionId: "sess-1", caller: null },
      );
      expect(events).toHaveLength(2);
      expect(events[1]?.sessionId).toBe("sess-1");
      expect(events[1]?.caller).toBeNull();
    } finally {
      v.cleanup();
    }
  });
});

describe("FTS-indexed lexical path (line 344 search_text, line 521 search_vault textHits)", () => {
  it("search_text uses the real FTS candidate path when metadataIndex reports ready, with the same hit set as the disk scan", async () => {
    const v = makeCustomVault({
      files: {
        "fox.md": "a quick brown fox jumps over the fence",
        "dog.md": "# Dog\n\nthe lazy dog sleeps",
      },
      metadataIndex: { hasFts: true, ready: () => true },
    });
    try {
      await v.call("index_vault", { vault: "test" }); // populates notes_fts for real
      const d = payload(await v.call("search_text", { vault: "test", query: "fox" }));
      expect(d.items.map((i: { path: string }) => i.path)).toEqual(["fox.md"]);
      expect(d.items[0].line).toBeGreaterThan(0);
    } finally {
      v.cleanup();
    }
  });

  it("search_vault mode:auto's textHits also uses the FTS path when metadataIndex reports ready", async () => {
    const v = makeCustomVault({
      files: {
        "fox.md": "a quick brown fox jumps over the fence",
        "dog.md": "# Dog\n\nthe lazy dog sleeps",
      },
      metadataIndex: { hasFts: true, ready: () => true },
    });
    try {
      await v.call("index_vault", { vault: "test" });
      const d = payload(
        await v.call("search_vault", { vault: "test", query: "fox", explain: true }),
      );
      expect(d.mode_used).toBe("text");
      expect(d._explain.modes_tried).toEqual(["text"]);
      expect(d.items.map((i: { path: string }) => i.path)).toEqual(["fox.md"]);
    } finally {
      v.cleanup();
    }
  });
});
