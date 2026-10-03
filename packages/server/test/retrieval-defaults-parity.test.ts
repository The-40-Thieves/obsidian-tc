// ADR-0007 class (b), the WIRING half: with `retrieval.derivedDefaults` off, every rrfK call site
// must behave exactly as main did (k = 10 unless an explicit value), and with it on the derived
// value must reach every PER-VAULT site. Sites covered: graph_search (in-query), federated_search,
// multi_query, buildGraphSearchOptions (-> every M7 tool), capturePolicy (the logged policy record),
// and the gap-sweep/CLI gap search. The vault_graph_search federated tool passes no k of its own
// any more, so it is covered by the structural scan plus federated_search.
//
// The structural test is the class guard: a bare literal rrfK constant added anywhere outside the
// resolver fails here by file and line, because a property test alone cannot see a site it does not
// call.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import type { GraphSearchOptions, GraphSearchResult } from "../src/search/graph_search";

const spy = vi.hoisted(() => ({
  fn: vi.fn(),
  real: undefined as unknown as (...a: never[]) => unknown,
}));
vi.mock("../src/search/graph_search", async (orig) => {
  const mod = await orig<typeof import("../src/search/graph_search")>();
  spy.real = mod.graphSearch as never;
  return { ...mod, graphSearch: spy.fn };
});

import { makeGapBatchSearch } from "../src/runtime/gap-sweep";
import { federatedGraphSearch } from "../src/search/federated_search";
import type { graphSearch } from "../src/search/graph_search";
import { multiQueryGraphSearch } from "../src/search/multi_query";
import { DEFAULT_RRF_K } from "../src/search/retrieval-defaults";
import { floatBlob } from "../src/search/vec";
import type { M7Deps } from "../src/tools/m7/knowledge/deps";
import {
  buildGraphSearchOptions,
  capturePolicy,
} from "../src/tools/m7/knowledge/retrieval-runtime";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const MODEL = "test:embed";
const VAULT = "v";

function result(path: string): GraphSearchResult {
  return {
    chunk_id: `c-${path}`,
    path,
    source: "seed",
    hop: 0,
    via_edge: null,
    root_seed: null,
    rerank_score: 0,
  };
}

/** Lists where k decides the order: `shared.md` sits at rank 5 in BOTH lists, `solo.md` at rank 1 in
 *  one. shared beats solo iff 2/(k+5) > 1/(k+1) iff k > 3 — so k=10 and k=1 fuse differently. */
const LIST_A = ["solo.md", "a2.md", "a3.md", "a4.md", "shared.md"].map(result);
const LIST_B = ["b1.md", "b2.md", "b3.md", "b4.md", "shared.md"].map(result);
const order = (r: Array<{ path: string }>) => r.map((x) => x.path);

/** A real index with `n` embedded chunks in vault "v" (plus the edges table graph_search reads). */
function indexOf(n: number): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );`,
  );
  for (let i = 0; i < n; i++) {
    const c = Math.max(0.05, 0.95 - i * 0.02);
    const vec = [c, Math.sqrt(1 - c * c), 0, 0];
    db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(`c${i}`, VAULT, `n${i}.md`, "0", "[]", "filler", `h${i}`, 1, 0, 0);
    db.prepare(
      "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
    ).run(`c${i}`, MODEL, 4, floatBlob(vec));
  }
  return db;
}

const BASE = {
  query: "no lexical terms here",
  queryVec: [1, 0, 0, 0],
  vaultId: VAULT,
  finalTopK: 30,
  router: { enabled: false as const },
  lexical: { enabled: false as const },
};

/** Run the REAL graphSearch and report the k its fusion applied. */
async function effectiveK(
  db: Database,
  over: Partial<GraphSearchOptions>,
): Promise<number | undefined> {
  let k: number | undefined;
  await (spy.real as unknown as typeof graphSearch)(db, {
    ...BASE,
    ...over,
    onFusionWeights: (w) => {
      k = w.rrfK;
    },
  } as GraphSearchOptions);
  return k;
}

const depsWith = (retrieval?: Record<string, unknown>): M7Deps =>
  ({
    embeddingProvider: { id: MODEL },
    vaultRegistry: new VaultRegistry([{ id: VAULT, path: "/nonexistent/retrieval-defaults" }]),
    reranker: null,
    roles: null,
    ...(retrieval ? { retrieval } : {}),
  }) as unknown as M7Deps;

/** deps -> buildGraphSearchOptions -> the real graphSearch: the k a tool call would fuse with. */
async function kViaBuilder(
  db: Database,
  retrieval: Record<string, unknown> | undefined,
  onFusionWeights?: GraphSearchOptions["onFusionWeights"],
): Promise<{ built: Record<string, unknown>; k: number | undefined }> {
  let k: number | undefined;
  const built = buildGraphSearchOptions(depsWith(retrieval), {
    route: { class: "standard" },
    query: BASE.query,
    queryVec: BASE.queryVec,
    vaultId: VAULT,
    finalTopK: 30,
    reranker: null,
    isReadable: () => true,
    db,
    acl: undefined,
    grantedScopes: new Set<string>(),
    onFusionWeights: (w: Parameters<NonNullable<GraphSearchOptions["onFusionWeights"]>>[0]) => {
      k = w.rrfK;
      onFusionWeights?.(w);
    },
  } as never);
  await (spy.real as unknown as typeof graphSearch)(db, {
    ...built,
    router: { enabled: false },
    lexical: { enabled: false },
  } as GraphSearchOptions);
  return { built: built as unknown as Record<string, unknown>, k };
}

// The shapes main used: `opts.rrfK ?? 10`, `deps.retrieval?.rrfK ?? 10`, and the named
// constants `DEFAULT_FAN_OUT_RRF_K = 10` / `DEFAULT_RRF_K = 10` / `FEDERATED_RRF_K`.
const BARE = /rrfK\s*\?\?\s*\d|(?:FAN_OUT_)?RRF_K\s*=\s*\d|FEDERATED_RRF_K/;
const RESOLVER = "search/retrieval-defaults.ts";

/** Offenders as `rel/path.ts:line: text`, skipping the resolver itself. `join`/`readdirSync` yield
 *  `\` separators and a checkout can carry CRLF on Windows, so paths are normalised to "/" and lines
 *  split on `\r?\n` before anything is compared (the resolver skip failed on Windows without this). */
function findBareRrfK(files: Array<{ path: string; text: string }>, srcRoot: string): string[] {
  const root = `${srcRoot.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
  const offenders: string[] = [];
  for (const f of files) {
    const path = f.path.replaceAll("\\", "/");
    if (path.endsWith(RESOLVER)) continue;
    f.text.split(/\r?\n/).forEach((line, i) => {
      if (BARE.test(line))
        offenders.push(
          `${path.startsWith(root) ? path.slice(root.length) : path}:${i + 1}: ${line.trim()}`,
        );
    });
  }
  return offenders;
}

describe("structural: no bare rrfK literal outside the resolver", () => {
  const SRC = fileURLToPath(new URL("../src", import.meta.url));
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  })(SRC);

  it("scans a plausible number of files (existence floor)", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("graph_search, federated_search, multi_query, the federated tool, the episode fuser and the policy record all route through the resolver", () => {
    expect(
      findBareRrfK(
        files.map((path) => ({ path, text: readFileSync(path, "utf8") })),
        SRC,
      ),
    ).toEqual([]);
  });

  // Off-Windows coverage of the Windows-only failure: the resolver's own `DEFAULT_RRF_K = 10` was
  // reported because `endsWith("search/retrieval-defaults.ts")` never matched a `\` path.
  it("skips the resolver whatever the separator, and still reports a real offender", () => {
    const resolver = "export const DEFAULT_RRF_K = 10;\r\n";
    const bare = "const a = 1;\r\nconst k = opts.rrfK ?? 10;\r\n";
    expect(
      findBareRrfK(
        [{ path: "C:\\r\\src\\search\\retrieval-defaults.ts", text: resolver }],
        "C:\\r\\src",
      ),
    ).toEqual([]);
    expect(
      findBareRrfK([{ path: "/r/src/search/retrieval-defaults.ts", text: resolver }], "/r/src"),
    ).toEqual([]);
    expect(
      findBareRrfK([{ path: "C:\\r\\src\\search\\graph_search.ts", text: bare }], "C:\\r\\src"),
    ).toEqual(["search/graph_search.ts:2: const k = opts.rrfK ?? 10;"]);
  });
});

describe("flag OFF: every call site is byte-identical to main", () => {
  beforeEach(() => {
    spy.fn.mockReset();
    spy.fn.mockImplementation((...a: never[]) => spy.real(...a));
  });

  it("graph_search in-query: constant 10 unless an explicit k; the flag absent/false never derives", async () => {
    const tiny = indexOf(6);
    expect(await effectiveK(tiny, {})).toBe(10);
    expect(await effectiveK(tiny, { derivedDefaults: false })).toBe(10);
    expect(await effectiveK(tiny, { rrfK: 7 })).toBe(7);
    expect(DEFAULT_RRF_K).toBe(10);
  });

  it("federated_search: default fusion == explicit k=10 (vault-composite keys make k order-inert there)", async () => {
    const legs = (): Parameters<typeof federatedGraphSearch>[0] => [
      { vaultId: "a", run: async () => ({ results: LIST_A, meta: undefined }) },
      { vaultId: "b", run: async () => ({ results: LIST_B, meta: undefined }) },
    ];
    const dflt = await federatedGraphSearch(legs(), 30);
    const k10 = await federatedGraphSearch(legs(), 30, { rrfK: DEFAULT_RRF_K });
    expect(order(dflt.fused)).toEqual(order(k10.fused));
    expect(dflt.fused.map((r) => r.vault)).toEqual(k10.fused.map((r) => r.vault));
  });

  it("multi_query: default fusion == explicit k=10, != k=1", async () => {
    spy.fn.mockImplementation(async (_db: unknown, o: { query: string }) =>
      o.query === "A" ? LIST_A : LIST_B,
    );
    const run = (over: Record<string, unknown> = {}) =>
      multiQueryGraphSearch(
        {} as Database,
        { query: "A", vaultId: VAULT, finalTopK: 30, ...over } as never,
        ["A", "B"],
      );
    const dflt = await run();
    expect(order(dflt)).toEqual(order(await run({ multiQueryFanOut: { rrfK: DEFAULT_RRF_K } })));
    expect(order(dflt)).not.toEqual(order(await run({ multiQueryFanOut: { rrfK: 1 } })));
  });

  it("buildGraphSearchOptions: no rrfK / derivedDefaults key unless configured; k fused is 10", async () => {
    const tiny = indexOf(6);
    for (const cfg of [undefined, {}, { derivedDefaults: false }]) {
      const { built, k } = await kViaBuilder(tiny, cfg);
      expect(Object.hasOwn(built, "rrfK")).toBe(false);
      expect(Object.hasOwn(built, "derivedDefaults")).toBe(false);
      expect(k).toBe(10);
    }
    const { built, k } = await kViaBuilder(tiny, { rrfK: 42 });
    expect(built.rrfK).toBe(42);
    expect(k).toBe(42);
  });

  it("capturePolicy: logs 10 by default and the explicit config value otherwise", async () => {
    const tiny = indexOf(6);
    const logged = async (cfg?: Record<string, unknown>) => {
      const policy = capturePolicy(VAULT, "standard");
      await kViaBuilder(tiny, cfg, policy.sink);
      return policy.record("static").rrfK;
    };
    expect(await logged()).toBe(10);
    expect(await logged({ derivedDefaults: false })).toBe(10);
    expect(await logged({ rrfK: 42 })).toBe(42);
  });

  it("gap search: no rrfK / derivedDefaults handed to graphSearch unless configured", async () => {
    spy.fn.mockResolvedValue([]);
    const provider = { id: MODEL, embed: async (q: string[]) => q.map(() => [1]) };
    const call = async (extra: Record<string, unknown>) => {
      spy.fn.mockClear();
      await makeGapBatchSearch({
        cacheDb: indexOf(6),
        provider,
        vaultId: VAULT,
        ...extra,
      } as never)(["q"]);
      return spy.fn.mock.calls[0]?.[1] as Record<string, unknown>;
    };
    for (const extra of [{}, { derivedDefaults: false }]) {
      const o = await call(extra);
      expect(Object.hasOwn(o, "rrfK")).toBe(false);
      expect(Object.hasOwn(o, "derivedDefaults")).toBe(false);
    }
    expect((await call({ rrfK: 42 })).rrfK).toBe(42);
  });
});

describe("flag ON: the derived value reaches every per-vault site; explicit values still win", () => {
  beforeEach(() => {
    spy.fn.mockReset();
    spy.fn.mockImplementation((...a: never[]) => spy.real(...a));
  });

  it("graph_search derives from THIS vault's stats (6 chunks -> 2; >= 30 chunks -> the constant)", async () => {
    expect(await effectiveK(indexOf(6), { derivedDefaults: true })).toBe(2);
    expect(await effectiveK(indexOf(12), { derivedDefaults: true })).toBe(4);
    expect(await effectiveK(indexOf(40), { derivedDefaults: true })).toBe(10);
  });

  it("an explicit per-call k beats derived", async () => {
    expect(await effectiveK(indexOf(6), { derivedDefaults: true, rrfK: 25 })).toBe(25);
  });

  it("the derivation honours the seedCount actually searched", async () => {
    // 6 chunks, seedCount 3 -> pool 3 -> k = round(3/3) = 1 -> clamped to 2.
    expect(await effectiveK(indexOf(6), { derivedDefaults: true, seedCount: 3 })).toBe(2);
    expect(await effectiveK(indexOf(60), { derivedDefaults: true, seedCount: 60 })).toBe(20);
  });

  it("only a genuinely restricted ACL partition disables derived defaults", async () => {
    const tiny = indexOf(6);
    expect(
      await effectiveK(tiny, {
        derivedDefaults: true,
        aclSetId: 1,
        // The set id alone is enough to reproduce the old derivation guard; keep the join dark in
        // this focused unit fixture because it intentionally provisions no ACL-set tables.
        aclWalkFilter: { enabled: false },
      }),
    ).toBe(2);
    expect(
      await effectiveK(tiny, {
        derivedDefaults: true,
        aclSetId: 1,
        aclWalkFilter: { enabled: false, restricted: true },
      }),
    ).toBe(10);
    expect(
      await effectiveK(tiny, { derivedDefaults: true, aclWalkFilter: { blocked: true } as never }),
    ).toBe(10);
  });

  it("buildGraphSearchOptions forwards the flag; the tool-call k is derived per vault, explicit config wins", async () => {
    const tiny = indexOf(6);
    const on = await kViaBuilder(tiny, { derivedDefaults: true });
    expect(on.built.derivedDefaults).toBe(true);
    expect(Object.hasOwn(on.built, "rrfK")).toBe(false);
    expect(on.k).toBe(2);
    expect((await kViaBuilder(tiny, { derivedDefaults: true, rrfK: 60 })).k).toBe(60);
    expect((await kViaBuilder(indexOf(40), { derivedDefaults: true })).k).toBe(10);
  });

  it("the policy record logs the k that ACTUALLY ran (derived), so provenance cannot lie", async () => {
    const tiny = indexOf(6);
    const cfg = { derivedDefaults: true };
    const policy = capturePolicy(VAULT, "standard");
    await kViaBuilder(tiny, cfg, policy.sink);
    expect(policy.record("static").rrfK).toBe(2);
  });

  it("gap search derives per vault too, and an explicit k still wins", async () => {
    const provider = { id: MODEL, embed: async (q: string[]) => q.map(() => [1, 0, 0, 0]) };
    let k: number | undefined;
    spy.fn.mockImplementation(async (db: Database, o: GraphSearchOptions) =>
      (spy.real as unknown as typeof graphSearch)(db, {
        ...o,
        router: { enabled: false },
        lexical: { enabled: false },
        onFusionWeights: (w) => {
          k = w.rrfK;
        },
      }),
    );
    await makeGapBatchSearch({
      cacheDb: indexOf(6),
      provider,
      vaultId: VAULT,
      derivedDefaults: true,
    } as never)(["q"]);
    expect(k).toBe(2);
    await makeGapBatchSearch({
      cacheDb: indexOf(6),
      provider,
      vaultId: VAULT,
      derivedDefaults: true,
      rrfK: 25,
    } as never)(["q"]);
    expect(k).toBe(25);
  });

  it("cross-list fusion (multi-query variants) ignores the per-vault derivation: k stays the constant", async () => {
    spy.fn.mockImplementation(async (_db: unknown, o: { query: string }) =>
      o.query === "A" ? LIST_A : LIST_B,
    );
    const run = (over: Record<string, unknown>) =>
      multiQueryGraphSearch(
        {} as Database,
        { query: "A", vaultId: VAULT, finalTopK: 30, ...over } as never,
        ["A", "B"],
      );
    expect(order(await run({ derivedDefaults: true }))).toEqual(order(await run({})));
  });
});
