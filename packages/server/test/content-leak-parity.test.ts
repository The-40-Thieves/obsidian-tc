// Read-ACL parity for every surface that returns note CONTENT, plugin-passthrough rows, or
// aggregates derived from the vault — the surfaces search-acl-parity.test.ts does not cover.
//
// The bug class (same as search-acl-parity): a caller who holds the tool's scope but lacks a path's
// RULE-scope (`secret/**` requiring `read:secret`) is refused by read_notes, yet another tool
// returned the same note's body, path, excerpt or count. `enforcePathAcl` used to take the caller's
// scopes as an OPTIONAL argument, so ~120 handler-side calls enforced the folder whitelist only and
// every tool without a central `pathAcl` extractor was open to that caller.
//
// One oracle (read_notes, from acl-parity-harness) and one scan (assertNoLeak) per surface, each
// with a POSITIVE control (the scope is granted and the hidden note must appear) so a surface that
// returns nothing cannot pass as "no leak".
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CapabilityCache, createBridgeClient, fakeBridgeTransport } from "../src/bridge";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { persistGapReport } from "../src/experiential/gaps";
import type { ToolRegistry } from "../src/mcp/registry";
import { createHealthTool, createIndexStatusTool } from "../src/tools/admin/health";
import { registerM3Tools } from "../src/tools/m3";
import { registerM4Tools } from "../src/tools/m4";
import { registerM5Tools } from "../src/tools/m5";
import { registerM8Tools } from "../src/tools/m8";
import { captureSnapshot } from "../src/vault/snapshots";
import {
  assertNoLeak,
  BASE_SCOPES,
  DOCS,
  type Harness,
  type HarnessParts,
  HIDDEN,
  leaks,
  MAIN,
  MARK,
  OTHER,
  RULE_SCOPE,
  readNotesAllows,
  strings,
  useHarness,
} from "./acl-parity-harness";
import { openMemoryDb } from "./helpers";

const build = useHarness();
const PRIV_EXTRA = ["read:secret"];
const DAILY = "2026-01-15";
const DAILY_PATH = `secret/${DAILY}.md`;
const BAD = "secret/bad.md";
const R = "/obsidian-tc/v1";

const EXPERIENTIAL_CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
  version: versionOf(file),
  sql: readFileSync(fileURLToPath(new URL(`../src/migrations/${file}`, import.meta.url)), "utf8"),
}));

const ok = (result: unknown) => ({ body: { ok: true, result } });

const ROUTES = {
  [`POST ${R}/datacore/query`]: ok({
    items: [
      { path: "pub/a.md", name: "a", tags: ["topic"], types: ["page"], fields: { kind: "memo" } },
      {
        path: HIDDEN,
        name: "b",
        tags: ["topic"],
        types: ["page"],
        fields: { note: `zebra ${MARK}` },
      },
    ],
    total: 2,
    query: "@page",
  }),
  [`POST ${R}/omnisearch/search`]: ok({
    items: [
      {
        path: "pub/a.md",
        basename: "a",
        score: 5,
        excerpt: "zebra public",
        found_words: ["zebra"],
        matches: [],
      },
      {
        path: HIDDEN,
        basename: "b",
        score: 9,
        excerpt: `zebra ${MARK}`,
        found_words: ["zebra"],
        matches: [],
      },
    ],
    total: 2,
    query: "zebra",
  }),
  [`POST ${R}/daily-notes/resolve`]: ok({
    date: DAILY,
    folder: "secret",
    format: "YYYY-MM-DD",
    path: DAILY_PATH,
    exists: true,
  }),
};

const GAP_ITEMS = [
  {
    id: "q1",
    query: "zebra",
    top_score: 0.9,
    results: 2,
    gap: false,
    nearest: [
      { path: HIDDEN, score: 0.9 },
      { path: "pub/a.md", score: 0.05 },
    ],
  },
];

/** The shared fixture plus every tool family the content surfaces live in. */
function wire(registry: ToolRegistry, parts: HarnessParts): void {
  const { roots, vaultRegistry, aclByVault, rootAcl } = parts;
  const write = (rel: string, content: string): void => {
    const abs = join(roots[0] as string, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  // A daily note that lives under the rule-scoped folder, and a note whose YAML cannot parse (so
  // index_vault reports it in frontmatter_failures with its path).
  write(".obsidian/daily-notes.json", JSON.stringify({ folder: "secret", format: "YYYY-MM-DD" }));
  write(DAILY_PATH, `---\nmood: ok\n---\n# Daily\n\nzebra ${MARK} daily body\n`);
  write(BAD, "---\nfoo: [unclosed\n---\n# Bad\n");

  const capabilities = new CapabilityCache();
  for (const id of [MAIN, OTHER, DOCS])
    capabilities.set(id, {
      companion: "reachable",
      plugins: { datacore: { installed: true }, omnisearch: { installed: true } },
    });
  const client = createBridgeClient({
    baseUrl: "http://127.0.0.1:27124",
    apiKey: "test-key",
    fetchFn: fakeBridgeTransport({ routes: ROUTES }),
  });
  registerM3Tools(registry, { vaultRegistry });
  registerM4Tools(registry, { vaultRegistry, capabilities, bridgeFor: () => client });
  registerM5Tools(registry, {
    vaultRegistry,
    cacheDir: roots[0] as string,
    bootstrap: {
      deepPaths: [HIDDEN, "pub/a.md"],
      domains: [{ name: "z", signals: ["zebra"], paths: [HIDDEN, "pub/a.md"] }],
      maxPaths: 10,
      deepPhrases: ["catch me up"],
    },
  } as never);
  const edb = openMemoryDb();
  runMigrations(edb, EXPERIENTIAL_CHAIN);
  persistGapReport(
    edb,
    { threshold: 0.1, min_results: 2, total: 1, gaps: 0, gap_rate: 0, items: GAP_ITEMS },
    { vaultId: MAIN, computedAt: 1000 },
  );
  registerM8Tools(registry, { edb } as never);
  registry.register(
    createHealthTool({
      version: "0.0.0",
      vaults: [MAIN, OTHER, DOCS],
      startedAt: 0,
      nativeLoaded: false,
      vecEnabled: true,
      aclFor: (id) => aclByVault.get(id) ?? rootAcl,
      getIndexHealth: (detail) => ({
        reconcile: "degraded",
        reconcile_at: 1,
        write_failures: 0,
        notes_ready: true,
        ...(detail
          ? {
              detail: {
                reconcile_errors: [{ vault: MAIN, error: `invalid frontmatter in ${BAD}` }],
              },
            }
          : {}),
      }),
    }),
  );
  registry.register(
    createIndexStatusTool({
      vecEnabled: true,
      ftsEnabled: true,
      getIndexHealth: () => ({
        reconcile: "ok",
        reconcile_at: 1,
        write_failures: 0,
        notes_ready: true,
      }),
      getLastChunksUpserted: () => 42,
      getInFlightProgress: () => ({
        vault: MAIN,
        notesSeen: 3,
        notesProcessed: 1,
        chunksUpserted: 5,
        startedAt: 1,
      }),
      aclFor: (id) => aclByVault.get(id) ?? rootAcl,
      vaultIds: () => [MAIN, OTHER, DOCS],
    }),
  );
}

interface ContentSurface {
  name: string;
  tool: string;
  /** Scopes the tool itself requires, on top of BASE_SCOPES. */
  scopes: string[];
  input: (h: Harness) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

const SURFACES: ContentSurface[] = [
  {
    name: "bundle_files",
    tool: "bundle_files",
    scopes: ["read:context"],
    input: () => ({ vault: MAIN, paths: ["pub/a.md", HIDDEN] }),
  },
  {
    name: "read_snapshot",
    tool: "read_snapshot",
    scopes: [],
    // Captured directly (as write_note would have): the reader is what is under test, and a
    // restricted ACL would refuse the capture call itself.
    input: (h) => {
      const raw = readFileSync(join(h.parts.roots[0] as string, HIDDEN), "utf8");
      const id = captureSnapshot(
        h.parts.db,
        { enabled: true, retention: 10 },
        MAIN,
        HIDDEN,
        raw,
        "manual",
      );
      return { vault: MAIN, snapshot_id: id };
    },
  },
  {
    name: "get_periodic_note",
    tool: "get_periodic_note",
    scopes: ["read:periodic"],
    input: () => ({ vault: MAIN, period: "daily", date: DAILY }),
  },
  {
    name: "session_bootstrap(standard)",
    tool: "session_bootstrap",
    scopes: [],
    input: () => ({ vault: MAIN, message: "zebra", mode: "standard" }),
  },
  {
    name: "session_bootstrap(deep)",
    tool: "session_bootstrap",
    scopes: [],
    input: () => ({ vault: MAIN, message: "catch me up", mode: "deep" }),
  },
  {
    name: "query_datacore",
    tool: "query_datacore",
    scopes: ["read:datacore"],
    input: () => ({ vault: MAIN, query: "@page" }),
  },
  {
    name: "search_omnisearch",
    tool: "search_omnisearch",
    scopes: ["read:omnisearch"],
    input: () => ({ vault: MAIN, query: "zebra" }),
  },
  {
    name: "resolve_daily_note",
    tool: "resolve_daily_note",
    scopes: ["read:daily-notes"],
    input: () => ({ vault: MAIN, date: DAILY }),
  },
];

/** A denied call is fail-closed (acl_denied), which is also parity with read_notes. */
async function callSurface(h: Harness, s: ContentSurface, scopes: string[]) {
  const input = await s.input(h);
  return h.call(s.tool, input, [...BASE_SCOPES, ...s.scopes, ...scopes]);
}

describe("content surfaces: the caller lacks the scope a path's rule requires", () => {
  for (const s of SURFACES) {
    it(`${s.name} returns nothing read_notes refuses`, async () => {
      const h = await build({ main: RULE_SCOPE }, wire);
      const allowed = await readNotesAllows(h, MAIN, BASE_SCOPES);
      expect(allowed.has(HIDDEN)).toBe(false);
      const r = await callSurface(h, s, []);
      if (r.ok) assertNoLeak(s.name, r.data, allowed);
      else expect(r.error?.code, JSON.stringify(r)).toBe("acl_denied");
      // An error envelope must not carry the note either.
      expect(
        strings(r).some((x) => x.includes(MARK)),
        `${s.name}: text in the envelope`,
      ).toBe(false);
    });

    it(`${s.name} still returns the note once the scope is granted (positive control)`, async () => {
      const h = await build({ main: RULE_SCOPE }, wire);
      const r = await callSurface(h, s, PRIV_EXTRA);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(
        strings(r.data).some((x) => x.includes(MARK) || x.includes("secret/")),
        `${s.name}: expected the granted caller to see the scoped note`,
      ).toBe(true);
    });

    it(`${s.name} under strictReadDefault (nothing readable) returns nothing`, async () => {
      const h = await build({ main: { strictReadDefault: true, ...RULE_SCOPE } }, wire);
      const r = await callSurface(h, s, []);
      if (r.ok) assertNoLeak(s.name, r.data, new Set());
      else expect(r.error?.code).toBe("acl_denied");
    });

    it(`${s.name} with a readPaths whitelist that excludes the scoped folder returns nothing`, async () => {
      const h = await build({ main: { readPaths: ["pub/**"], ...RULE_SCOPE } }, wire);
      const r = await callSurface(h, s, PRIV_EXTRA);
      if (r.ok) assertNoLeak(s.name, r.data, new Set(["pub/a.md"]));
      else expect(r.error?.code).toBe("acl_denied");
    });
  }
});

describe("plugin passthroughs filter rows, not just refuse", () => {
  it("query_datacore keeps the readable row, drops the hidden one, and recounts", async () => {
    const h = await build({ main: RULE_SCOPE }, wire);
    const r = await h.call("query_datacore", { vault: MAIN, query: "@page" }, [
      ...BASE_SCOPES,
      "read:datacore",
    ]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.data.items.map((i: { path: string }) => i.path)).toEqual(["pub/a.md"]);
    expect(r.data.total).toBe(1);
  });

  it("search_omnisearch keeps the readable row, drops the hidden one, and recounts", async () => {
    const h = await build({ main: RULE_SCOPE }, wire);
    const r = await h.call("search_omnisearch", { vault: MAIN, query: "zebra" }, [
      ...BASE_SCOPES,
      "read:omnisearch",
    ]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.data.items.map((i: { path: string }) => i.path)).toEqual(["pub/a.md"]);
    expect(r.data.total).toBe(1);
    expect(leaks(r.data)).toBe(false);
  });

  it("resolve_daily_note is refused (not blanked) for a path the caller cannot read", async () => {
    const h = await build({ main: RULE_SCOPE }, wire);
    const r = await h.call("resolve_daily_note", { vault: MAIN, date: DAILY }, [
      ...BASE_SCOPES,
      "read:daily-notes",
    ]);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("acl_denied");
  });
});

describe("index_vault does not name notes the caller cannot read", () => {
  it("frontmatter_failures is filtered per caller; the shared index is untouched", async () => {
    const h = await build({ main: RULE_SCOPE }, wire);
    const low = await h.call("index_vault", { vault: MAIN }, [...BASE_SCOPES, "admin:vault"]);
    expect(low.ok, JSON.stringify(low)).toBe(true);
    expect(strings(low.data).some((x) => x.includes(BAD))).toBe(false);
    expect(low.data.frontmatter_failures).toEqual([]);
    expect(low.data.notes_frontmatter_failed).toBe(0);
    // A caller who holds the scope sees it (positive control) — the run itself indexed it.
    const high = await h.call("index_vault", { vault: MAIN }, [
      ...BASE_SCOPES,
      "admin:vault",
      ...PRIV_EXTRA,
    ]);
    expect(high.ok, JSON.stringify(high)).toBe(true);
    expect(high.data.frontmatter_failures.map((f: { path: string }) => f.path)).toEqual([BAD]);
    expect(high.data.notes_frontmatter_failed).toBe(1);
  });
});

describe("aggregates do not count notes the caller cannot read", () => {
  const chunkCount = (h: Harness, vault: string, exceptHidden: boolean): number =>
    (
      h.parts.db
        .prepare(
          `SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ?${exceptHidden ? " AND path NOT LIKE 'secret/%'" : ""}`,
        )
        .get(vault) as { n: number }
    ).n;

  it("list_vaults / get_vault chunk_count is the caller's own readable count", async () => {
    const h = await build({ main: RULE_SCOPE }, wire);
    const total = chunkCount(h, MAIN, false);
    const visible = chunkCount(h, MAIN, true);
    expect(visible).toBeLessThan(total);
    const low = await h.call("list_vaults", {}, BASE_SCOPES);
    expect(low.data.vaults.find((v: { id: string }) => v.id === MAIN).chunk_count).toBe(visible);
    const lowOne = await h.call("get_vault", { vault: MAIN }, BASE_SCOPES);
    expect(lowOne.data.cache.chunk_count).toBe(visible);
    const scopes = [...BASE_SCOPES, ...PRIV_EXTRA];
    const high = await h.call("list_vaults", {}, scopes);
    expect(high.data.vaults.find((v: { id: string }) => v.id === MAIN).chunk_count).toBe(total);
    const highOne = await h.call("get_vault", { vault: MAIN }, scopes);
    expect(highOne.data.cache.chunk_count).toBe(total);
  });

  it("list_vaults / get_vault count applies EACH vault's own ACL", async () => {
    const h = await build({ main: {}, other: RULE_SCOPE }, wire);
    const low = await h.call("list_vaults", {}, BASE_SCOPES);
    const byId = new Map(
      low.data.vaults.map((v: { id: string; chunk_count: number }) => [v.id, v.chunk_count]),
    );
    expect(byId.get(MAIN)).toBe(chunkCount(h, MAIN, false));
    expect(byId.get(OTHER)).toBe(chunkCount(h, OTHER, true));
  });

  it("get_index_status withholds folder-walk progress from a caller without full read", async () => {
    const h = await build({ main: RULE_SCOPE }, wire);
    const low = await h.call("get_index_status", {}, BASE_SCOPES);
    expect(low.ok, JSON.stringify(low)).toBe(true);
    expect(low.data.chunks_upserted).toBeNull();
    expect(low.data.in_flight).toBeUndefined();
    const high = await h.call("get_index_status", {}, [...BASE_SCOPES, ...PRIV_EXTRA]);
    expect(high.data.chunks_upserted).toBe(42);
    expect(high.data.in_flight?.vault).toBe(MAIN);
  });

  it("server_health index.detail (reconcile errors name notes by path) needs full read", async () => {
    const h = await build({ main: RULE_SCOPE }, wire);
    const low = await h.call("server_health", {}, BASE_SCOPES);
    expect(low.ok, JSON.stringify(low)).toBe(true);
    expect(strings(low.data).some((x) => x.includes(BAD))).toBe(false);
    expect(low.data.index.detail).toBeUndefined();
    const high = await h.call("server_health", {}, [...BASE_SCOPES, ...PRIV_EXTRA]);
    expect(strings(high.data).some((x) => x.includes(BAD))).toBe(true);
  });

  it("get_index_status: ANOTHER vault's rule-scope withholds it too", async () => {
    const h = await build({ main: {}, other: RULE_SCOPE }, wire);
    const low = await h.call("get_index_status", {}, BASE_SCOPES);
    expect(low.data.chunks_upserted).toBeNull();
    expect(low.data.in_flight).toBeUndefined();
  });

  it("gap_report recomputes top_score / results / gap from the items the caller can see", async () => {
    const h = await build({ main: RULE_SCOPE }, wire);
    const low = await h.call("gap_report", { vault: MAIN }, BASE_SCOPES);
    expect(low.ok, JSON.stringify(low)).toBe(true);
    const item = low.data.items[0];
    expect(item.nearest.map((n: { path: string }) => n.path)).toEqual(["pub/a.md"]);
    // The hidden hit scored 0.9 and was the top hit: none of that may show through.
    expect(item.top_score).toBe(0.05);
    expect(item.results).toBe(1);
    expect(item.gap).toBe(true);
    expect(low.data.gaps).toBe(1);
    expect(JSON.stringify(low.data)).not.toContain("0.9");
    const high = await h.call("gap_report", { vault: MAIN }, [...BASE_SCOPES, ...PRIV_EXTRA]);
    expect(high.data.items[0].top_score).toBe(0.9);
    expect(high.data.items[0].results).toBe(2);
    expect(high.data.gaps).toBe(0);
  });
});
