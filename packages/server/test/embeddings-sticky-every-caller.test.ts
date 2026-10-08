// THE-1122 review round 2 (finding 2): the caller-discovery test this file replaces
// (cli-embeddings-sticky-callers.test.ts, deleted) was a SOURCE-SCAN — it discovered "every file
// that imports and calls" one of three entry-point symbols by regex, then asserted a SUBSTRING of
// one of three sticky-marker function names appeared ANYWHERE in that file. It could not see
// `rerun.ts` (which only imports `buildServerRuntime`, never the entry points directly) and could
// not tell a call BEFORE construction from one after, or in a dead branch, from one that actually
// ran. That is exactly how the review's finding 1 (`rerun` silently building "local" and dropping
// `vec_chunks`) stayed invisible to a green gate.
//
// This is a BEHAVIORAL table instead: for every real command/entry point that can construct an
// embedding provider, seed a cache db as a pre-1.31.4 install would have left it (an ACTIVE
// `ollama:nomic-embed-text` row at 768 dims, no `embeddings` block in config at all — the real
// "unconfigured install" shape), run the REAL production function against an unconfigured config,
// and assert the constructed identity is "ollama" — never the schema-defaulted "local". A new
// command that constructs a provider without going through the sticky choke point
// (embeddings/sticky-provider.ts's applyStickyEmbeddings, now applied INSIDE
// runtime/indexing-wiring.ts's wireIndexResources for every wireIndexResources-based path — see
// that function's own doc comment for why THIS fix closes the class, not just the named callers)
// is one new row away from being covered, and fails loudly if it is NOT sticky by construction.
//
// `serve`, `index`, and `rerun` all fold into `wireIndexResources` (directly, or transitively via
// `buildServerRuntime`), so each of those three rows ALSO proves `chunk_embeddings` survives
// untouched, and — ONLY in an environment where the sqlite-vec extension actually loads —
// `vec_chunks`/`vec_index_fingerprint` too: the concrete GH #995 failure mode (a fingerprint
// mismatch DROPS and rebuilds the table). `ensureVecChunks` (search/vec.ts) never creates
// `vec_index_fingerprint` when `loadVec` fails, which is exactly what happens under this repo's
// own CI (`build-test` runs vitest under plain `node` with `--ignore-scripts`, so `openDatabase`
// falls back to the `node:sqlite` adapter, which exposes no `loadExtension` — db/node-node-sqlite
// .ts's own header). Every row's PRIMARY evidence is therefore the sticky notice / resolved
// provider (which none of that depends on), and the vec-table checks are additive, guarded by
// `hasVecFingerprintTable`. `prefetch`/`gaps`/`citation-infer`/`cluster` construct a provider
// through the sync `createEmbeddingProvider` path (no vec DDL of their own) and are proven by the
// STICKY NOTICE they print to stdout before attempting any network call — reached deterministically
// before either row's provider construction, so no live ollama/gateway needs to be reachable for
// this test to be meaningful. `doctor` calls the shared resolver
// (`probeEmbeddingsProviderSource`, the exact function `cli/commands/doctor.ts` calls with the
// exact inputs it computes) directly rather than running the full `run_doctor()` CLI end to end —
// deliberately: doctor-embeddings-sticky-order.test.ts's own header already documents why a full
// `run_doctor()` integration (capability-profile probe, bridge probes, stdout/process.exit
// interception) is a materially more expensive test for a narrower property than this file's other
// seven rows, which none of that machinery touches. This still exercises the real, shared,
// production resolver — never a re-implementation — with the same inputs doctor.ts itself computes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run_citation_infer } from "../src/cli/commands/citation-infer";
import { run_cluster } from "../src/cli/commands/cluster";
import { probeEmbeddingsProviderSource } from "../src/cli/commands/doctor-probes";
import { run_gaps } from "../src/cli/commands/gaps";
import { run_index } from "../src/cli/commands/index";
import { run_prefetch } from "../src/cli/commands/prefetch";
import { run_rerun } from "../src/cli/commands/rerun";
import { finalizeConfig } from "../src/config/load";
import { tableExists } from "../src/db/introspect";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { isEmbeddingsProviderExplicitOnConfig } from "../src/embeddings/provider-explicit";
import * as indexingWiring from "../src/runtime/indexing-wiring";
import { buildServerRuntime } from "../src/runtime/server-runtime";
import { makeTempDir, rmTemp } from "./tmp";

const SEEDED_DIMENSIONS = 768;

/** Pre-1.31.4-shaped cache.db: one active `ollama:nomic-embed-text` row, nothing else — no
 *  `embeddings` block anywhere for these rows' config to name. */
async function seedOllamaCache(cacheDir: string): Promise<void> {
  mkdirSync(cacheDir, { recursive: true });
  const db = await openDatabase(join(cacheDir, "cache.db"));
  provisionCacheDb(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at)
     VALUES ('c1', 'main', 'a.md', '0', '[]', 'x', 'hash', 1, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at)
     VALUES ('c1', 'ollama:nomic-embed-text', ?, ?, 1, ?)`,
  ).run(SEEDED_DIMENSIONS, Buffer.alloc(SEEDED_DIMENSIONS * 4), now);
  db.close?.();
}

// `vec_index_fingerprint` is only created inside `ensureVecChunks`, gated on `loadVec(db)`
// succeeding (search/vec.ts) — the same guard `probeStoredEmbeddingsProvider`
// (cli/commands/doctor-probes.ts) and `activeVecFingerprint` (metrics/gauge-sources.ts) already
// apply before reading it. CI's Node 24 `build-test` legs delete better-sqlite3 after install,
// so `openDatabase` falls back to the
// `node:sqlite` adapter, which exposes no `loadExtension` — `loadVec` returns false there and the
// table never gets created (see db/node-node-sqlite.ts's own header). Returning `undefined` here
// mirrors that production guard exactly, via the same shared `tableExists` (db/introspect.ts),
// instead of the two ROWS below being the only unguarded readers of this table in the whole repo.
async function readVecFingerprintProvider(cacheDir: string): Promise<string | undefined> {
  const db = await openDatabase(join(cacheDir, "cache.db"), undefined, { readonly: true });
  try {
    if (!tableExists(db, "vec_index_fingerprint")) return undefined;
    const row = db.prepare("SELECT fingerprint FROM vec_index_fingerprint WHERE id = 1").get() as
      | { fingerprint?: string }
      | undefined;
    return row?.fingerprint?.split("|")[0];
  } finally {
    db.close?.();
  }
}

// Distinct from `readVecFingerprintProvider`'s own internal `tableExists` check: this is the row
// loop's explicit "is this environment even able to see vec_chunks/vec_index_fingerprint" gate, so
// a present-but-somehow-empty fingerprint row (a real bug) cannot be mistaken for "vec is simply
// unavailable here" (the CI/node:sqlite case) and silently skipped.
async function hasVecFingerprintTable(cacheDir: string): Promise<boolean> {
  const db = await openDatabase(join(cacheDir, "cache.db"), undefined, { readonly: true });
  try {
    return tableExists(db, "vec_index_fingerprint");
  } finally {
    db.close?.();
  }
}

async function readSeededRowStillActive(cacheDir: string): Promise<boolean> {
  const db = await openDatabase(join(cacheDir, "cache.db"), undefined, { readonly: true });
  try {
    const row = db
      .prepare("SELECT model, is_active FROM chunk_embeddings WHERE chunk_id = 'c1'")
      .get() as { model: string; is_active: number } | undefined;
    return row?.model === "ollama:nomic-embed-text" && row.is_active === 1;
  } finally {
    db.close?.();
  }
}

interface Row {
  name: string;
  /** True for rows that fold into `wireIndexResources` (vec_chunks/fingerprint DDL) — asserted
   *  untouched in addition to the notice/output evidence every row provides. */
  touchesVec: boolean;
  run(ctx: { configPath: string; cacheDir: string; vaultDir: string }): Promise<string>;
}

const ROWS: Row[] = [
  {
    name: "serve (buildServerRuntime, cli.ts's own call shape)",
    touchesVec: true,
    run: async ({ configPath, cacheDir }) => {
      const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      const config = finalizeConfig(raw);
      config.cacheDir = cacheDir;
      const runtime = await buildServerRuntime(config, configPath, undefined, true);
      try {
        return config.embeddings.provider;
      } finally {
        await runtime.close("test cleanup");
      }
    },
  },
  {
    name: "rerun (run_rerun — GH #995 review's own regression, observe mode, no --sandbox)",
    touchesVec: true,
    run: async ({ configPath }) => {
      // rerun.ts's buildServerRuntime call never reaches start() (see rerun.ts's own comment on
      // that call), so emitBootNotices — the ONLY thing that prints the sticky notice on this path
      // — never runs, and the seeded vault has no notes, so chunk_embeddings never changes either.
      // Neither stdout/stderr capture nor a DB read is meaningful evidence for THIS row. Spy on the
      // real, live `wireIndexResources` binding instead (the one choke point rerun.ts reaches only
      // transitively through buildServerRuntime -> wireRuntimeCore — see indexing-wiring.ts's own
      // header for why this is the class the GH #995 review's finding 1 needed closed) and read
      // back what it actually constructed, independent of whether this environment can load
      // sqlite-vec at all.
      const spy = vi.spyOn(indexingWiring, "wireIndexResources");
      const prevExitCode = process.exitCode;
      try {
        // No such session exists — rerunSession throws AFTER buildServerRuntime has already run
        // (observe mode builds the FULL runtime before ever reading the session row), which is
        // exactly what this row needs: the sticky-resolution/provider-construction side effect
        // this test checks already happened by the time that throw surfaces. run_rerun itself
        // never throws (see rerun.ts's own header) — it sets process.exitCode and returns.
        await run_rerun({ kind: "rerun", input: configPath, sessionId: "no-such-session" });
        const call = spy.mock.results[0];
        if (call?.type !== "return") return "";
        const resources = await call.value;
        return resources.embeddingProvider.id as string;
      } finally {
        process.exitCode = prevExitCode;
        spy.mockRestore();
      }
    },
  },
  {
    name: "index (run_index)",
    touchesVec: true,
    run: async ({ configPath }) => {
      // index.ts prints the same sticky notice to stdout before any vec DDL runs — evidence that
      // does not depend on `vec_index_fingerprint` existing, unlike the table read this row used
      // to be alone in.
      const out = captureOutput();
      try {
        await run_index({ kind: "index", input: configPath });
      } finally {
        out.restore();
      }
      return out.text();
    },
  },
  {
    name: "prefetch (run_prefetch)",
    touchesVec: false,
    run: async ({ configPath }) => {
      const out = captureOutput();
      try {
        await run_prefetch({ kind: "prefetch", input: configPath });
      } catch {
        // Downstream (gateway/embed) failure is expected and irrelevant — see this file's header.
      } finally {
        out.restore();
      }
      return out.text();
    },
  },
  {
    name: "gaps (run_gaps)",
    touchesVec: false,
    run: async ({ configPath }) => {
      const out = captureOutput();
      try {
        await run_gaps({ kind: "gaps", input: configPath, queries: "/nonexistent-queries.yaml" });
      } catch {
        // Expected: the queries file does not exist, and/or the embed call is unreachable — both
        // happen strictly AFTER the sticky notice this row checks for.
      } finally {
        out.restore();
      }
      return out.text();
    },
  },
  {
    name: "citation-infer (run_citation_infer)",
    touchesVec: false,
    run: async ({ configPath }) => {
      const out = captureOutput();
      try {
        await run_citation_infer({
          kind: "citation-infer",
          input: configPath,
          transcriptIndex: "/nonexistent-transcript-index.jsonl",
        });
      } catch {
        // Expected — see the gaps row above.
      } finally {
        out.restore();
      }
      return out.text();
    },
  },
  {
    name: "cluster (run_cluster)",
    touchesVec: false,
    run: async ({ configPath }) => {
      const out = captureOutput();
      try {
        await run_cluster({ kind: "cluster", input: configPath });
      } catch {
        // Expected — see the gaps row above.
      } finally {
        out.restore();
      }
      return out.text();
    },
  },
  {
    name: "doctor (probeEmbeddingsProviderSource — the exact resolver run_doctor calls; see this file's header)",
    touchesVec: false,
    run: async ({ configPath, cacheDir }) => {
      const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      const config = finalizeConfig(raw);
      const resolution = await probeEmbeddingsProviderSource(cacheDir, config.db.busyTimeoutMs, {
        providerExplicit: isEmbeddingsProviderExplicitOnConfig(config.embeddings),
        onProviderChange: config.embeddings.onProviderChange,
        configured: {
          provider: config.embeddings.provider,
          model: config.embeddings.model,
          dimensions: config.embeddings.dimensions,
        },
        vaultIds: config.vaults.map((v) => v.id),
      });
      return resolution?.provider ?? "";
    },
  },
];

// Captures BOTH streams into one buffer — the sticky notice goes to stdout from the CLI commands
// (index.ts, gaps.ts, citation-infer.ts, cluster.ts, prefetch.ts) but to stderr from the two paths
// that go through server-runtime.ts's emitBootNotices (serve, rerun — boot-notices.ts). A caller
// that only spied stdout would see nothing from those two and could not tell "no notice printed"
// from "wrong stream".
function captureOutput(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const record = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(record);
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(record);
  return {
    text: () => chunks.join(""),
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

describe("every embedding-provider construction entry point keeps a pre-1.31.4 ollama index sticky (THE-1122 round 2, finding 2)", () => {
  const tmpDirs: string[] = [];
  const tmpDir = (prefix: string): string => {
    const d = makeTempDir(prefix);
    tmpDirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        rmTemp(d);
      } catch {
        // best-effort, matching every other temp-dir test in this suite.
      }
    }
  });

  for (const row of ROWS) {
    it(`${row.name} — resolves/reports "ollama", never the schema-defaulted "local"`, async () => {
      const vaultDir = tmpDir("otc-sticky-every-vault-");
      const cacheDir = tmpDir("otc-sticky-every-cache-");
      const confDir = tmpDir("otc-sticky-every-conf-");
      const configPath = join(confDir, "config.json");
      // No `embeddings` block at all — the real "unconfigured install" shape.
      writeFileSync(
        configPath,
        JSON.stringify({ cacheDir, vaults: [{ id: "main", path: vaultDir }] }),
      );
      await seedOllamaCache(cacheDir);

      const evidence = await row.run({ configPath, cacheDir, vaultDir });
      expect(evidence, `${row.name} produced no evidence of resolving "ollama"`).toMatch(/ollama/);

      if (row.touchesVec) {
        // chunk_embeddings always exists (provisionCacheDb) — this half of the GH #995 regression
        // (the seeded row surviving untouched) is checked regardless of vec availability.
        expect(await readSeededRowStillActive(cacheDir)).toBe(true);
        // vec_chunks/vec_index_fingerprint only exist when the sqlite-vec extension loaded (CI's
        // node:sqlite fallback never creates them — see readVecFingerprintProvider's header).
        // `evidence` above already proved "ollama" from the notice/resolved provider in every
        // environment; this is the ADDITIONAL, stronger check for the ones that can see vec DDL.
        if (await hasVecFingerprintTable(cacheDir)) {
          expect(await readVecFingerprintProvider(cacheDir)).toBe("ollama");
        }
      }
    });
  }

  // The floor every source-scan-replacement test needs (feedback_every_gate_needs_an_existence_floor):
  // a broken driver silently returning "" for every row would still pass an empty suite. This pins
  // the row count so a driver regression (e.g. every `it` above throwing before its assertion) is
  // visible as a COUNT change, not just individually-skipped failures.
  it("covers all eight entry points named in the GH #995 review", () => {
    expect(ROWS.map((r) => r.name.split(" (")[0]).sort()).toEqual(
      ["citation-infer", "cluster", "doctor", "gaps", "index", "prefetch", "rerun", "serve"].sort(),
    );
  });
});

// GH #995 fix round 2 (item A review): the explicitness marker (embeddings/provider-explicit.ts)
// keys a WeakMap by `config.embeddings` object IDENTITY, set exactly once by config/load.ts's
// finalizeConfig. The failure mode this guards against: any spread/clone between the loader and
// `wireIndexResources` that rebuilds `embeddings` as a NEW object loses the marker, which reads as
// "not explicit" (the safe-by-default side per that module's own header) — but an OPERATOR who
// explicitly wrote `embeddings.provider: "local"` needs that opt-in HONORED, not silently
// downgraded back to "keep". Proven end to end: the REAL loader (finalizeConfig, via
// resolveOrUsageExitWithProvenance -> buildServerRuntime, exactly cli.ts's own `serve` call
// shape), with active ollama vectors present that sticky resolution WOULD otherwise keep, but the
// explicit "local" must win instead.
describe("explicit embeddings.provider survives the real loader + real runtime (GH #995 item 0)", () => {
  const tmpDirs: string[] = [];
  const tmpDir = (prefix: string): string => {
    const d = makeTempDir(prefix);
    tmpDirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        rmTemp(d);
      } catch {
        // best-effort, matching every other temp-dir test in this suite.
      }
    }
  });

  it("constructs 'local' (never overridden to 'ollama') when embeddings.provider is explicit", async () => {
    const vaultDir = tmpDir("otc-sticky-explicit-vault-");
    const cacheDir = tmpDir("otc-sticky-explicit-cache-");
    const confDir = tmpDir("otc-sticky-explicit-conf-");
    const configPath = join(confDir, "config.json");
    // An EXPLICIT provider — the opt-in to switch, even with an existing ollama index present.
    writeFileSync(
      configPath,
      JSON.stringify({
        cacheDir,
        vaults: [{ id: "main", path: vaultDir }],
        embeddings: { provider: "local" },
      }),
    );
    await seedOllamaCache(cacheDir);

    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const config = finalizeConfig(raw);
    expect(isEmbeddingsProviderExplicitOnConfig(config.embeddings)).toBe(true);
    config.cacheDir = cacheDir;
    const runtime = await buildServerRuntime(config, configPath, undefined, true);
    try {
      expect(config.embeddings.provider).toBe("local");
    } finally {
      await runtime.close("test cleanup");
    }
    // wireIndexResources went all the way through construction/vec DDL under "local" — the marker
    // was not lost between the loader and the choke point. Only checkable where vec is available
    // (CI's node:sqlite fallback never creates vec_index_fingerprint — see
    // readVecFingerprintProvider's header); `config.embeddings.provider` above already proved the
    // resolution itself in every environment.
    if (await hasVecFingerprintTable(cacheDir)) {
      expect(await readVecFingerprintProvider(cacheDir)).toBe("local");
    }
  });
});
