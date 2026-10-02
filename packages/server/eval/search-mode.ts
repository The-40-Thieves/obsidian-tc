// Eval for retrieval.useSearchModePreference: `search_vault` with no `mode`, DEFAULT (auto) versus
// GUIDED (the reader wired to an experiential store whose profile for this (vault, caller) says
// preferred.search_mode = search_text), scored on a golden set.
//
// It drives the real tool through real dispatch, so the arms differ only by whether the production
// resolver is wired and what the profile holds. The profile is CONSTRUCTED (the eval corpora carry no
// episodes): `applyPreferenceDeltas` writes `--profile-adds` agreeing observations (5 reaches the
// documented 3.0 threshold). Prevalence on a realistic profile is a separate question, measured by
// running `extractPreferences` over recorded episodes, not here.
//
//   bun eval/search-mode.ts <config.json> <golden-set> --query-vecs <vecs.json> --arm default|guided
//        [--profile-adds 5] [--caller eval] [--auto-route text-first|weak-text|hybrid] --json <out.json>
//
// The artifact is shaped like `eval/run.ts --json` so `eval/history.ts record` accepts it: `graph`
// is THIS arm's search_vault result, `baseline` is dense-only `search_semantic` over the same query
// vectors (the same reference in both arms). `mode_used` / `mode_source` ride along per query; they
// are labels, not content. One query's paths are never logged.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { experientialMigrations } from "../src/cli/shared";
import { loadConfig } from "../src/config/load";
import { provisionExperientialDb } from "../src/db/experiential";
import { openConfiguredDatabase } from "../src/db/open";
import { createEmbeddingProvider } from "../src/embeddings";
import { applyPreferenceDeltas } from "../src/experiential/reflect";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { compileEgressFilter } from "../src/plane/egress-filter";
import { buildRepresentationManifest } from "../src/search/representation";
import { registerM2Tools } from "../src/tools/m2";
import { VaultRegistry } from "../src/vault/registry";
import { assertGoldenNotInVault } from "./golden-guard";
import {
  aggregateMetrics,
  computeQueryMetrics,
  GoldenSetSchema,
  type RankedChunk,
} from "./metrics";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const configPath = argv[0];
const goldenPath = argv[1];
const vecsPath = flag("--query-vecs");
const arm = flag("--arm");
const out = flag("--json");
const caller = flag("--caller") ?? "eval";
const profileAdds = Number(flag("--profile-adds") ?? 5);
// retrieval.searchAutoRoute for this arm: text-first (default) | weak-text | hybrid.
const autoRoute = flag("--auto-route") ?? "text-first";
if (autoRoute !== "text-first" && autoRoute !== "weak-text" && autoRoute !== "hybrid") {
  process.stderr.write(`unknown --auto-route ${autoRoute}\n`);
  process.exit(2);
}
if (!configPath || !goldenPath || !vecsPath || !out || (arm !== "default" && arm !== "guided")) {
  process.stderr.write(
    "usage: bun eval/search-mode.ts <config.json> <golden-set> --query-vecs <vecs.json> --arm default|guided [--profile-adds 5] [--caller eval] [--auto-route text-first|weak-text|hybrid] --json <out.json>\n",
  );
  process.exit(2);
}

const config = loadConfig(configPath);
const vault = config.vaults[0];
if (!vault) throw new Error("config.vaults is empty");
const golden = GoldenSetSchema.parse(parseYaml(readFileSync(goldenPath, "utf8")));
// Fail before scoring if the vault quotes the golden set (see eval/golden-guard.ts).
assertGoldenNotInVault(golden, vault.path);
const vecs = new Map<string, number[]>(
  Object.entries(JSON.parse(readFileSync(vecsPath, "utf8")) as Record<string, number[]>),
);

const base = createEmbeddingProvider(config.embeddings, {
  // Same egress guard every eval script threads: an excluded note's text must not reach the provider.
  excludeFilter: compileEgressFilter(config.egress.excludePaths),
  cacheDir: config.cacheDir,
});
// Query vectors are precomputed and shared by both arms (removes embedding noise from the pairing);
// `id` and every other member still come from the real provider, so the stored-model filter matches.
const provider = Object.assign(Object.create(base), {
  embed: async (texts: string[], o?: { input?: "query" | "document" }): Promise<number[][]> =>
    o?.input === "query"
      ? texts.map((t) => {
          const v = vecs.get(t);
          if (!v) throw new Error(`no precomputed vector for query "${t.slice(0, 40)}…"`);
          return v;
        })
      : base.embed(texts, o),
});

const db = await openConfiguredDatabase(config, "cache.db");
let searchModePreference: { edb: Awaited<ReturnType<typeof provisionExperientialDb>> } | undefined;
if (arm === "guided") {
  // A scratch experiential store, never the corpus's own: the profile is an input of the eval.
  const dir = mkdtempSync(join(tmpdir(), "smr-edb-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  const edb = await provisionExperientialDb(dir, experientialMigrations);
  for (let i = 0; i < profileAdds; i++)
    applyPreferenceDeltas(
      edb,
      vault.id,
      [{ key: "preferred.search_mode", op: "add", value: "search_text", scopeCaller: caller }],
      1_800_000_000_000 + i,
    );
  searchModePreference = { edb };
}

const registry = new ToolRegistry();
registerM2Tools(registry, {
  vaultRegistry: new VaultRegistry(config.vaults),
  embeddingProvider: provider,
  representation: buildRepresentationManifest(provider, {}),
  // Same as serve once the boot reconcile has committed: FTS-accelerated text search where the
  // index has it, the disk scan otherwise.
  metadataIndex: { hasFts: true, ready: () => true },
  ...(searchModePreference ? { searchModePreference } : {}),
  ...(autoRoute !== "text-first" ? { autoRoute } : {}),
});
const ctx: CallerContext = {
  caller,
  authenticated: true,
  grantedScopes: new Set(["*"]),
  vaultId: vault.id,
  db,
};

const asRanked = (items: Array<{ path: string }>): RankedChunk[] =>
  items.map((h, i) => ({ chunk_id: `${i}`, path: h.path }));
const call = async (name: string, input: Record<string, unknown>) => {
  const r = await registry.dispatch(name, input, ctx);
  if (!r.ok) throw new Error(`${name}: ${r.error.code}: ${r.error.message}`);
  return r.data as {
    items: Array<{ path: string }>;
    total: number;
    mode_used: string;
    mode_source?: string;
  };
};

const perQuery = [];
const modes: Record<string, number> = {};
for (const q of golden.queries) {
  const arm_ = await call("search_vault", { vault: vault.id, query: q.query_text });
  const dense = await call("search_semantic", {
    vault: vault.id,
    query: q.query_text,
    k: 50,
    return_content: false,
  });
  // Route diagnostics (independent of what auto chose): the text leg alone and its own score, so a
  // breakdown can say WHY auto routed as it did. Labels and counts only, never a path.
  const txt = await call("search_vault", {
    vault: vault.id,
    query: q.query_text,
    mode: "text",
    limit: 1000,
  });
  const key = `${arm_.mode_used}/${arm_.mode_source ?? "-"}`;
  modes[key] = (modes[key] ?? 0) + 1;
  perQuery.push({
    id: q.id,
    baseline: computeQueryMetrics(q, asRanked(dense.items)),
    graph: computeQueryMetrics(q, asRanked(arm_.items)),
    hard: false,
    z1: 0,
    mode_used: arm_.mode_used,
    mode_source: arm_.mode_source ?? null,
    hits: arm_.items.length,
    text_lines: txt.total,
    text_notes: new Set(txt.items.map((h) => h.path)).size,
    text: computeQueryMetrics(q, asRanked(txt.items)),
    query_tokens: q.query_text.split(/\s+/).filter(Boolean).length,
  });
}
const flags = [
  `search-mode-${arm}`,
  ...(autoRoute !== "text-first" ? [`auto-route-${autoRoute}`] : []),
];
writeFileSync(out, JSON.stringify({ flags, arm, caller, profileAdds, modes, perQuery }));
const agg = aggregateMetrics(perQuery.map((p) => p.graph));
process.stderr.write(
  `[search-mode] arm=${arm} n=${perQuery.length} modes=${JSON.stringify(modes)} ` +
    `nDCG@10=${agg.mean_ndcg_at_10.toFixed(4)} recall@10=${agg.mean_recall_at_10.toFixed(4)} MRR@10=${agg.mean_mrr_at_10.toFixed(4)}\n`,
);
db.close?.();
