// THE-222 — reflect MCP tool pins, via the lexical-route harness (rare term, throwing embed
// stub — no embedding backend). Covers: graceful degradation without the gateway (recall still
// returns sources), synthesis mode with a mock roles seam, challenge-mode delegation to the
// red-team core, persist provenance (and its write:notes gate).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { RetrievalLogger } from "../src/experiential/log";
import { ToolRegistry } from "../src/mcp/registry";
import { compileEgressFilter } from "../src/plane/egress-filter";
import type { GatewayRoles } from "../src/plane/gateway";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { floatBlob } from "../src/search/vec";
import { type M7Deps, registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb, stampAclPath } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const NOW = 1_700_000_000_000;

function cacheDb0() {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const ins = db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'main', ?, 0, '[]', ?, ?, 40, ?, ?)",
  );
  ins.run("c1", "notes/topic.md", "the quorble pattern part one", "h1", NOW, NOW);
  ins.run("d1", "02-projects/2026-01-01-quorble.md", "decision: quorble it", "h2", NOW, NOW);
  stampAclPath(db);
  ensureChunkFts(db, { now: () => NOW, enrich: false });
  return db;
}

function un<T>(r: unknown): T {
  return (r as { data: T }).data;
}

const root = makeTempDir("obtc-reflect-");
afterAll(() => rmTemp(root));

function harness(
  roles: GatewayRoles | null,
  scopes: string[] = ["read:notes"],
  opts: {
    db?: ReturnType<typeof openMemoryDb>;
    acl?: FolderAcl;
    retrievalLog?: RetrievalLogger;
    retrieval?: M7Deps["retrieval"];
    embeddingProvider?: M7Deps["embeddingProvider"];
    classRouter?: boolean;
    excludeFilter?: ReturnType<typeof compileEgressFilter>;
  } = {},
) {
  const registry = new ToolRegistry({});
  const vaultRegistry = new VaultRegistry([{ id: "main", name: "main", path: root }]);
  registerM7Tools(registry, {
    vaultRegistry,
    embeddingProvider:
      opts.embeddingProvider ??
      ({
        provider: "ollama",
        model: "stub",
        embed: async () => {
          throw new Error("embed must not be called");
        },
      } as any),
    reranker: null,
    roles,
    classRouter: opts.classRouter ?? true,
    ...(opts.retrievalLog ? { retrievalLog: opts.retrievalLog } : {}),
    ...(opts.retrieval ? { retrieval: opts.retrieval } : {}),
    ...(opts.excludeFilter ? { excludeFilter: opts.excludeFilter } : {}),
  });
  const ctx = {
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(scopes),
    vaultId: "main",
    db: opts.db ?? cacheDb0(),
    now: () => NOW,
    ...(opts.acl ? { acl: opts.acl } : {}),
  };
  return { registry, ctx };
}

const mockRoles: GatewayRoles = {
  extract: async () => ({ text: "{}", model: "mock" }),
  synthesize: async () => ({ text: "the grounded answer [1]", model: "mock-synth" }),
  judge: async () => ({
    text: JSON.stringify({ verdict: "reconsider", summary: "seen before", categories: [] }),
    model: "mock-judge",
  }),
};

interface ReflectData {
  mode: string;
  available: boolean;
  answer?: string | null;
  model?: string;
  sources: Array<{ chunk_id: string; path: string }>;
  challenge?: { verdict: string; summary: string };
  persisted?: { path: string };
}

it("keeps the reflect output doc comment attached to ReflectOutput", () => {
  const schemas = readFileSync(
    new URL("../src/tools/m7/knowledge/schemas.ts", import.meta.url),
    "utf8",
  );
  const coverageDeclaration = schemas.indexOf("export const ChallengeCoverageSchema");
  const reflectDoc = schemas.indexOf("/** reflect: three arms.");
  const reflectDeclaration = schemas.indexOf("export const ReflectOutput");
  expect(coverageDeclaration).toBeLessThan(reflectDoc);
  expect(reflectDoc).toBeLessThan(reflectDeclaration);
});

describe("reflect tool (THE-222)", () => {
  it("degrades gracefully: no gateway -> available false, recall sources still returned", async () => {
    const { registry, ctx } = harness(null);
    const res = un<ReflectData>(
      await registry.dispatch("reflect", { vault: "main", query: "quorble pattern" }, ctx),
    );
    expect(res.available).toBe(false);
    expect(res.answer).toBeNull();
    expect(res.sources.map((s) => s.chunk_id)).toContain("c1");
  });

  it("synthesis mode returns the grounded answer with model + sources", async () => {
    const { registry, ctx } = harness(mockRoles);
    const res = un<ReflectData>(
      await registry.dispatch("reflect", { vault: "main", query: "quorble pattern" }, ctx),
    );
    expect(res).toMatchObject({ mode: "synthesis", available: true, model: "mock-synth" });
    expect(res.answer).toContain("grounded answer");
    expect(res.sources.length).toBeGreaterThan(0);
  });

  it("scope filters recall to the path prefix", async () => {
    const { registry, ctx } = harness(mockRoles);
    const res = un<ReflectData>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: "quorble", scope: "09-reference/" },
        ctx,
      ),
    );
    expect(res.sources.every((s) => s.path.startsWith("09-reference/"))).toBe(true);
  });

  it("challenge mode delegates to the red-team core", async () => {
    const { registry, ctx } = harness(mockRoles);
    const res = un<ReflectData>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: "quorble", mode: "challenge" },
        ctx,
      ),
    );
    expect(res.mode).toBe("challenge");
    expect(res.challenge?.verdict).toBe("reconsider");
    expect(res.model).toBe("mock-judge");
  });

  it("challenge mode with no decision evidence refuses instead of asking the judge", async () => {
    let judged = 0;
    const counting: GatewayRoles = {
      ...mockRoles,
      judge: async (...args) => {
        judged++;
        return mockRoles.judge(...args);
      },
    };
    const { registry, ctx } = harness(counting);
    const res = un<ReflectData & { message?: string }>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: "quorble pattern", mode: "challenge", scope: "notes" },
        ctx,
      ),
    );
    expect(res.challenge).toBeUndefined();
    expect(res.message).toMatch(/no decision-bearing chunks/);
    expect(judged).toBe(0);
  });

  it("persist writes the derived note with provenance; gated on write:notes", async () => {
    const denied = harness(mockRoles); // read:notes only
    const r = (await denied.registry.dispatch(
      "reflect",
      { vault: "main", query: "quorble pattern", persist: true },
      denied.ctx,
    )) as { ok: boolean };
    expect(r.ok).toBe(false);

    const { registry, ctx } = harness(mockRoles, ["read:notes", "write:notes"]);
    const res = un<ReflectData>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: "quorble pattern", persist: true },
        ctx,
      ),
    );
    expect(res.persisted?.path).toMatch(
      /^memory\/reflections\/\d{4}-\d{2}-\d{2}-quorble-pattern\.md$/,
    );
    const abs = join(root, res.persisted?.path ?? "");
    expect(existsSync(abs)).toBe(true);
    const text = readFileSync(abs, "utf8");
    expect(text).toContain("source_model: mock-synth");
    expect(text).toContain("the grounded answer");
    expect(text).toContain("source_chunks:");
  });

  it("persist accepts a wildcard scope caller (grantsAll, not raw has)", async () => {
    // A caller holding `*` satisfies write:notes everywhere else (dispatch uses grantsAll), but the
    // old persist check was a raw Set `.has("write:notes")` that rejected them (audit THE-562 / P1.6).
    const { registry, ctx } = harness(mockRoles, ["*"]);
    const res = un<ReflectData>(
      await registry.dispatch("reflect", { vault: "main", query: "quorble", persist: true }, ctx),
    );
    expect(res.persisted?.path).toMatch(/^memory\/reflections\/\d{4}-\d{2}-\d{2}-quorble\.md$/);
    expect(existsSync(join(root, res.persisted?.path ?? ""))).toBe(true);
  });
});

describe("reflect tool — egress exclusion skip-and-report (THE-934 fix round 2, N1)", () => {
  it("an excluded note's content never reaches gateway.synthesize; excluded_count reports the skip", async () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const ins = db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'main', ?, 0, '[]', ?, ?, 40, ?, ?)",
    );
    ins.run("pub1", "Public/note.md", "vorplequonk term public content", "hpub", NOW, NOW);
    ins.run(
      "priv1",
      "Private/secret.md",
      "vorplequonk term SECRET_MARKER content",
      "hpriv",
      NOW,
      NOW,
    );
    stampAclPath(db);
    ensureChunkFts(db, { now: () => NOW, enrich: false });

    const registry = new ToolRegistry({});
    const vaultRegistry = new VaultRegistry([{ id: "main", name: "main", path: root }]);
    let capturedPrompt = "";
    const capturingRoles: GatewayRoles = {
      extract: async () => ({ text: "{}", model: "mock" }),
      synthesize: async (req) => {
        capturedPrompt = req.messages.map((m) => m.content).join("\n");
        return { text: "the grounded answer", model: "mock-synth" };
      },
      judge: mockRoles.judge,
    };
    registerM7Tools(registry, {
      vaultRegistry,
      embeddingProvider: {
        provider: "ollama",
        model: "stub",
        embed: async () => {
          throw new Error("embed must not be called");
        },
      } as any,
      reranker: null,
      roles: capturingRoles,
      classRouter: true,
      excludeFilter: compileEgressFilter(["Private/**"]),
    });
    const ctx = {
      caller: "tester",
      authenticated: true,
      grantedScopes: new Set(["read:notes"]),
      vaultId: "main",
      db,
      now: () => NOW,
    };
    const res = un<ReflectData & { excluded_count?: number }>(
      await registry.dispatch("reflect", { vault: "main", query: "vorplequonk term" }, ctx),
    );
    expect(res.available).toBe(true);
    expect(capturedPrompt).not.toContain("SECRET_MARKER");
    expect(capturedPrompt).toContain("public content");
    expect(res.excluded_count).toBe(1);
  });
});

describe("reflect egress: an excluded top-k hit is still returned, but its text is withheld", () => {
  const rows = [
    ["pub1", "Public/note.md", "vorplequonk term public content", "hpub"],
    ["priv1", "Private/secret.md", "vorplequonk term SECRET_MARKER content", "hpriv"],
  ] as const;
  const query = { vault: "main", query: "vorplequonk term" };

  function chunkDb(chunkRows: ReadonlyArray<readonly [string, string, string, string]> = rows) {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const ins = db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'main', ?, 0, '[]', ?, ?, 40, ?, ?)",
    );
    for (const [id, path, content, hash] of chunkRows) ins.run(id, path, content, hash, NOW, NOW);
    stampAclPath(db);
    ensureChunkFts(db, { now: () => NOW, enrich: false });
    return db;
  }

  it("synthesis: the excluded hit keeps its rank in sources and the log; its text never reaches the model", async () => {
    const baseline = un<ReflectData>(
      await harness(mockRoles, ["read:notes"], { db: chunkDb() }).registry.dispatch(
        "reflect",
        query,
        harness(mockRoles, ["read:notes"], { db: chunkDb() }).ctx,
      ),
    );
    const sent: string[] = [];
    const roles: GatewayRoles = {
      ...mockRoles,
      synthesize: async (req) => {
        sent.push(req.messages.map((m) => m.content).join("\n"));
        return { text: "the grounded answer", model: "mock-synth" };
      },
    };
    const logged: string[] = [];
    const { registry, ctx } = harness(roles, ["read:notes"], {
      db: chunkDb(),
      excludeFilter: compileEgressFilter(["Private/**"]),
      retrievalLog: (event) => logged.push(...event.hits.map((hit) => hit.chunkId)),
    });
    const res = un<ReflectData & { excluded_count?: number }>(
      await registry.dispatch("reflect", query, ctx),
    );
    const ids = res.sources.map((source) => source.chunk_id);
    expect(ids).toEqual(baseline.sources.map((source) => source.chunk_id));
    expect(ids).toContain("priv1");
    expect(logged).toEqual(ids);
    expect(sent.join("\n")).not.toContain("SECRET_MARKER");
    expect(sent.join("\n")).toContain("public content");
    expect(res.excluded_count).toBe(1);
  });

  it("degraded (no gateway): the excluded hit stays in sources and is counted as withheld", async () => {
    const logged: string[] = [];
    const { registry, ctx } = harness(null, ["read:notes"], {
      db: chunkDb(),
      excludeFilter: compileEgressFilter(["Private/**"]),
      retrievalLog: (event) => logged.push(...event.hits.map((hit) => hit.chunkId)),
    });
    const res = un<ReflectData & { excluded_count?: number }>(
      await registry.dispatch("reflect", query, ctx),
    );
    expect(res.available).toBe(false);
    expect(res.sources.map((source) => source.chunk_id)).toContain("priv1");
    expect(logged).toEqual(res.sources.map((source) => source.chunk_id));
    expect(res.excluded_count).toBe(1);
  });

  it("persist: provenance lists exactly the chunks the model was shown", async () => {
    // SYNTHESIS_EVIDENCE_BUDGET keeps at most 5 chunks per note, so the 6th recalled chunk of
    // this note is retrieved but never shown to the model.
    const manyRows = Array.from(
      { length: 6 },
      (_, i) =>
        [
          `m${i + 1}`,
          "Public/many.md",
          `vorplequonk term MANY${i + 1} content`,
          `hm${i + 1}`,
        ] as const,
    );
    let prompt = "";
    const roles: GatewayRoles = {
      ...mockRoles,
      synthesize: async (req) => {
        prompt = req.messages.map((m) => m.content).join("\n");
        return { text: "the grounded answer", model: "mock-synth" };
      },
    };
    const { registry, ctx } = harness(roles, ["read:notes", "write:notes"], {
      db: chunkDb(manyRows),
    });
    // A quoted phrase is an explicit lexical request, so the query never reaches the embedder.
    const res = un<ReflectData>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: '"vorplequonk term"', persist: true },
        ctx,
      ),
    );
    const shownIds = manyRows.filter(([, , content]) => prompt.includes(content)).map(([id]) => id);
    expect(shownIds).toHaveLength(5);
    const text = readFileSync(join(root, res.persisted?.path ?? ""), "utf8");
    const line = text.split("\n").find((l) => l.startsWith("source_chunks: "));
    const persisted = JSON.parse((line ?? "").slice("source_chunks: ".length)) as string[];
    expect([...persisted].sort()).toEqual([...shownIds].sort());
  });
});

describe("reflect challenge mode: decision filter, coverage, persist and ACL", () => {
  /** A FTS-indexed chunk store; `[id, path, content]` rows. */
  function seedPool(rows: ReadonlyArray<readonly [string, string, string]>) {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const ins = db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'main', ?, 0, '[]', ?, ?, 40, ?, ?)",
    );
    for (const [id, path, content] of rows) ins.run(id, path, content, `h-${id}`, NOW, NOW);
    stampAclPath(db);
    ensureChunkFts(db, { now: () => NOW, enrich: false });
    return db;
  }

  function expandedPoolRows(): ReadonlyArray<readonly [string, string, string]> {
    const leading = Array.from(
      { length: 40 },
      (_, i) => [`p${i}`, `notes/plain-${i}.md`, "quorble pattern"] as const,
    );
    const decision = [
      "d1",
      "02-projects/decide.md",
      `quorble pattern ${"filler ".repeat(80)}`,
    ] as const;
    const trailing = Array.from(
      { length: 60 },
      (_, i) =>
        [`tail${i}`, `notes/tail-${i}.md`, `quorble pattern ${"filler ".repeat(160)}`] as const,
    );
    return [...leading, decision, ...trailing];
  }

  /** Records the composed judge request, then returns a canned verdict. */
  function capturingRoles(sink: (composed: string) => void): GatewayRoles {
    return {
      ...mockRoles,
      judge: async (req) => {
        sink(req.messages.map((m) => m.content).join("\n"));
        return {
          text: JSON.stringify({ verdict: "reconsider", summary: "seen before", categories: [] }),
          model: "mock-judge",
        };
      },
    };
  }

  it("expands once to a bounded 90-hit pool when the first 30 underfill decision evidence", async () => {
    const db = seedPool(expandedPoolRows());
    const seen: string[] = [];
    const { registry, ctx } = harness(
      capturingRoles((m) => seen.push(m)),
      ["read:notes"],
      {
        db,
      },
    );
    const res = un<ReflectData & { coverage?: unknown }>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: '"quorble pattern"', mode: "challenge" },
        ctx,
      ),
    );
    expect(seen.join("\n")).toContain("02-projects/decide.md");
    expect(res.coverage).toMatchObject({ recalled: 90, decision_matched: 1 });
    expect(res.sources.map((source) => source.chunk_id)).toContain("d1");
  });

  it("logs only sources returned after expanded challenge recall", async () => {
    const loggedChunkIds: string[] = [];
    const { registry, ctx } = harness(
      capturingRoles(() => {}),
      ["read:notes"],
      {
        db: seedPool(expandedPoolRows()),
        retrievalLog: (event) => loggedChunkIds.push(...event.hits.map((hit) => hit.chunkId)),
      },
    );
    const res = un<ReflectData>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: '"quorble pattern"', mode: "challenge" },
        ctx,
      ),
    );
    expect(loggedChunkIds).toEqual(res.sources.map((source) => source.chunk_id));
  });

  it("an egress-excluded chunk from the expanded ranks is neither returned, credited nor counted", async () => {
    const body = `quorble pattern ${"filler ".repeat(80)}`;
    const rows = [
      ...expandedPoolRows().filter(([id]) => id !== "d1"),
      ["d1", "02-projects/decide.md", body] as const,
      ["d2", "02-projects/private/secret.md", body] as const,
    ];
    const seen: string[] = [];
    const loggedChunkIds: string[] = [];
    const { registry, ctx } = harness(
      capturingRoles((m) => seen.push(m)),
      ["read:notes"],
      {
        db: seedPool(rows),
        excludeFilter: compileEgressFilter(["02-projects/private/**"]),
        retrievalLog: (event) => loggedChunkIds.push(...event.hits.map((hit) => hit.chunkId)),
      },
    );
    const res = un<ReflectData & { excluded_count?: number }>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: '"quorble pattern"', mode: "challenge" },
        ctx,
      ),
    );
    const sourceIds = res.sources.map((source) => source.chunk_id);
    expect(seen.join("\n")).toContain("02-projects/decide.md");
    expect(seen.join("\n")).not.toContain("02-projects/private/secret.md");
    expect(sourceIds).toContain("d1");
    expect(sourceIds).not.toContain("d2");
    expect(loggedChunkIds).toEqual(sourceIds);
    // d2 is an expanded-rank judge candidate, not a returned top-k hit, so it is not withheld from
    // any returned source and excluded_count (returned top-k only) omits it.
    expect(res.excluded_count).toBeUndefined();
  });

  it("returns egress-excluded top-k sources at their rank, withholding their text from the judge", async () => {
    const seen: string[] = [];
    const loggedChunkIds: string[] = [];
    const { registry, ctx } = harness(
      capturingRoles((m) => seen.push(m)),
      ["read:notes"],
      {
        db: seedPool(expandedPoolRows()),
        excludeFilter: compileEgressFilter(["notes/plain-*.md"]),
        retrievalLog: (event) => loggedChunkIds.push(...event.hits.map((hit) => hit.chunkId)),
      },
    );
    const res = un<ReflectData & { excluded_count?: number }>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: '"quorble pattern"', mode: "challenge" },
        ctx,
      ),
    );
    const sourceIds = res.sources.map((source) => source.chunk_id);
    expect(sourceIds).toContain("p0");
    expect(seen.join("\n")).not.toContain("notes/plain-");
    expect(seen.join("\n")).toContain("02-projects/decide.md");
    expect(loggedChunkIds).toEqual(sourceIds);
    expect(res.excluded_count).toBe(
      res.sources.filter((source) => source.path.startsWith("notes/plain-")).length,
    );
  });

  it("evidence the egress filter empties refuses instead of calling the judge", async () => {
    let judged = 0;
    const counting: GatewayRoles = {
      ...mockRoles,
      judge: async (...args) => {
        judged++;
        return mockRoles.judge(...args);
      },
    };
    const loggedChunkIds: string[] = [];
    const { registry, ctx } = harness(counting, ["read:notes"], {
      db: seedPool(expandedPoolRows()),
      excludeFilter: compileEgressFilter(["02-projects/**"]),
      retrievalLog: (event) => loggedChunkIds.push(...event.hits.map((hit) => hit.chunkId)),
    });
    const res = un<
      ReflectData & {
        message?: string;
        excluded_count?: number;
        coverage?: { kept: number; truncated: number; low_coverage: boolean };
      }
    >(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: '"quorble pattern"', mode: "challenge" },
        ctx,
      ),
    );
    expect(judged).toBe(0);
    expect(res.challenge).toBeUndefined();
    expect(res.message).toMatch(/after egress exclusion/);
    expect(res.coverage).toMatchObject({ kept: 0, truncated: 0, low_coverage: true });
    expect(res.sources.map((source) => source.chunk_id)).not.toContain("d1");
    expect(loggedChunkIds).not.toContain("d1");
  });

  it("a scope that empties the first page still expands (fullness is counted before scope)", async () => {
    const leading = Array.from(
      { length: 40 },
      (_, i) => [`p${i}`, `notes/plain-${i}.md`, "quorble pattern"] as const,
    );
    const decision = [
      "d1",
      "02-projects/decide.md",
      `quorble pattern ${"filler ".repeat(80)}`,
    ] as const;
    const trailing = Array.from(
      { length: 60 },
      (_, i) =>
        [`tail${i}`, `notes/tail-${i}.md`, `quorble pattern ${"filler ".repeat(160)}`] as const,
    );
    const seen: string[] = [];
    const { registry, ctx } = harness(
      capturingRoles((m) => seen.push(m)),
      ["read:notes"],
      { db: seedPool([...leading, decision, ...trailing]) },
    );
    const res = un<ReflectData & { coverage?: unknown }>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: '"quorble pattern"', mode: "challenge", scope: "02-projects/" },
        ctx,
      ),
    );
    expect(seen.join("\n")).toContain("02-projects/decide.md");
    expect(res.coverage).toMatchObject({ recalled: 1, decision_matched: 1 });
  });

  it("challenge mode honours k above the default recall depth", async () => {
    const rows = Array.from(
      { length: 50 },
      (_, i) =>
        [`d${i}`, `02-projects/decide-${i}.md`, `quorble pattern ${"filler ".repeat(40)}`] as const,
    );
    const { registry, ctx } = harness(
      capturingRoles(() => {}),
      ["read:notes"],
      { db: seedPool(rows) },
    );
    const res = un<ReflectData>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: '"quorble pattern"', mode: "challenge", k: 45 },
        ctx,
      ),
    );
    expect(res.sources).toHaveLength(45);
  });

  it("the expanded graph-search page widens the seed streams, not only finalTopK", async () => {
    // 50 plain chunks sit exactly on the query vector and match the query text; the decision chunk
    // is further away and matches neither stream, so only a seed stream deeper than 30 reaches it.
    const plain = Array.from(
      { length: 50 },
      (_, i) => [`p${i}`, `notes/plain-${i}.md`, "quorble pattern"] as const,
    );
    const decision = ["d1", "02-projects/decide.md", "unrelated wording"] as const;
    const rows = [...plain, decision];
    const db = seedPool(rows);
    for (const [id] of rows) {
      db.prepare(
        "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, 'stub-embed', 2, ?, 1, 0)",
      ).run(id, floatBlob(id === "d1" ? [0.7, 0.7] : [1, 0]));
    }
    const seen: string[] = [];
    const { registry, ctx } = harness(
      capturingRoles((message) => seen.push(message)),
      ["read:notes"],
      {
        db,
        classRouter: false,
        embeddingProvider: {
          id: "stub-embed",
          provider: "ollama",
          model: "stub-embed",
          dimensions: 2,
          embed: async () => [[1, 0]],
        },
      },
    );
    await registry.dispatch(
      "reflect",
      { vault: "main", query: "quorble pattern", mode: "challenge" },
      ctx,
    );
    expect(seen.join("\n")).toContain("02-projects/decide.md");
  });

  it("gateway-unavailable challenge mode keeps the caller's recall depth", async () => {
    const rows = Array.from(
      { length: 40 },
      (_, i) => [`p${i}`, `notes/plain-${i}.md`, "quorble pattern"] as const,
    );
    let loggedHits = -1;
    const { registry, ctx } = harness(null, ["read:notes"], {
      db: seedPool(rows),
      retrievalLog: (event) => {
        loggedHits = event.hits.length;
      },
    });
    const res = un<ReflectData>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: '"quorble pattern"', mode: "challenge", k: 5 },
        ctx,
      ),
    );
    expect(res.available).toBe(false);
    expect(res.sources).toHaveLength(5);
    expect(loggedHits).toBe(5);
  });

  it("a denied decision note leaves the output identical to it being absent (ACL before count)", async () => {
    // The readable decision note is the only decision the caller may see. The denied one shares
    // its wording and its folder, so any count taken before the ACL filter would show it.
    const acl = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      readPaths: ["02-projects/decide.md", "notes/**"],
    });
    const decisionBody = `quorble pattern ${"filler ".repeat(80)}`;
    const base = [
      ["p0", "notes/plain.md", "quorble pattern"],
      ["d1", "02-projects/decide.md", decisionBody],
    ] as const;
    const run = async (withSecret: boolean) => {
      const rows = withSecret
        ? [...base, ["s1", "02-projects/secret.md", decisionBody] as const]
        : base;
      const seen: string[] = [];
      const { registry, ctx } = harness(
        capturingRoles((m) => seen.push(m)),
        ["read:notes"],
        {
          db: seedPool(rows),
          acl,
        },
      );
      const res = await registry.dispatch(
        "reflect",
        { vault: "main", query: '"quorble pattern"', mode: "challenge" },
        ctx,
      );
      return { res, prompt: seen.join("\n") };
    };
    const absent = await run(false);
    const present = await run(true);
    // Guard against a vacuous pass: both runs must reach the judge with the readable decision.
    expect(absent.prompt).toContain("02-projects/decide.md");
    expect(present).toEqual(absent);
    expect(present.prompt).not.toContain("02-projects/secret.md");
  });

  it("counts only ACL-readable results when the graph stream is enabled", async () => {
    const rows = [
      ["allowed", "02-projects/allowed.md", "quorble pattern allowed decision"],
      ["plain", "notes/plain.md", "quorble pattern plain note"],
      ["denied", "02-projects/denied.md", "quorble pattern denied decision"],
    ] as const;
    const db = seedPool(rows);
    for (const [id] of rows) {
      db.prepare(
        "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, 'stub-embed', 2, ?, 1, 0)",
      ).run(id, floatBlob([1, 0]));
    }
    const acl = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      readPaths: ["02-projects/allowed.md", "notes/**"],
    });
    const seen: string[] = [];
    const { registry, ctx } = harness(
      capturingRoles((message) => seen.push(message)),
      ["read:notes"],
      {
        db,
        acl,
        classRouter: false,
        retrieval: { graphStream: { enabled: true } },
        embeddingProvider: {
          id: "stub-embed",
          provider: "ollama",
          model: "stub-embed",
          dimensions: 2,
          embed: async () => [[1, 0]],
        },
      },
    );
    const res = un<ReflectData & { coverage?: unknown }>(
      await registry.dispatch(
        "reflect",
        { vault: "main", query: "quorble pattern", mode: "challenge" },
        ctx,
      ),
    );
    expect(res.coverage).toMatchObject({ recalled: 2, decision_matched: 1 });
    expect(seen.join("\n")).toContain("02-projects/allowed.md");
    expect(seen.join("\n")).not.toContain("02-projects/denied.md");
  });

  it("rejects persist with mode challenge with a validation error instead of ignoring it", async () => {
    const { registry, ctx } = harness(mockRoles, ["read:notes", "write:notes"]);
    const r = await registry.dispatch(
      "reflect",
      { vault: "main", query: "quorble pattern", mode: "challenge", persist: true },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("validation_error");
  });
});

it("reflect challenge: a judge call that throws still logs the retrieval it ran on", async () => {
  const logged: string[] = [];
  const throwingRoles: GatewayRoles = {
    ...mockRoles,
    judge: async () => {
      throw new Error("gateway unavailable");
    },
  };
  const { registry, ctx } = harness(throwingRoles, ["read:notes"], {
    retrievalLog: (event) => logged.push(...event.hits.map((hit) => hit.chunkId)),
  });
  await registry
    .dispatch("reflect", { vault: "main", query: '"quorble pattern"', mode: "challenge" }, ctx)
    .catch(() => undefined);
  expect(logged).toContain("d1");
});
