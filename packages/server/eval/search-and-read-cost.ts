// search_and_read cost eval: the same queries answered two ways, through the real registry and the
// real governor, counting what an agent actually pays for a "search, then read the hits" task.
//
//   control    vault_graph_search, then read_notes over its top-k distinct notes (following
//              next_cursor when the batch pages)
//   treatment  search_and_read, following next_cursor when the result pages
//
// Both arms are scored with the harness's own computeQueryMetrics over the notes they RETURNED, so
// an arm that saved bytes by losing a hit would show up as a recall drop. `baseline` in the
// artifact is the control and `graph` is the treatment, which keeps the file recordable with
// eval/history.ts (`record <out.json> --corpus <golden-set> --label <name>`).
//
// Usage: bun eval/search-and-read-cost.ts <config.json> <golden-set.{yaml,json}> --json <out.json>
//          [--k 10] [--limit N]
// Needs an indexed cache.db under config.cacheDir (see eval/README.md). Tokens are search/chunk.ts's
// estimateTokens (chars/4) over each request and each response: an estimate, applied to both arms.
import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { FolderAcl } from "../src/acl";
import { loadConfig } from "../src/config/load";
import { openConfiguredDatabase } from "../src/db/open";
import { createEmbeddingProvider } from "../src/embeddings";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { compileEgressFilter } from "../src/plane/egress-filter";
import { estimateTokens } from "../src/search/chunk";
import { registerM1Tools } from "../src/tools/m1";
import { registerM7Tools } from "../src/tools/m7";
import { candidatePoolSize } from "../src/tools/m7/knowledge/search-and-read";
import { VaultRegistry } from "../src/vault/registry";
import { computeQueryMetrics, GoldenSetSchema, type RankedChunk } from "./metrics";
import type { EvalQueryResult } from "./run";

interface Cost {
  calls: number;
  request_bytes: number;
  response_bytes: number;
  tokens: number;
  /** UTF-8 bytes of note text handed to the agent (body, or section text). */
  note_bytes: number;
  notes: number;
  truncated: number;
}

const emptyCost = (): Cost => ({
  calls: 0,
  request_bytes: 0,
  response_bytes: 0,
  tokens: 0,
  note_bytes: 0,
  notes: 0,
  truncated: 0,
});

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
  const [configPath, goldenPath] = positional;
  const outPath = flag(argv, "--json");
  const k = Number(flag(argv, "--k") ?? 10);
  const limit = flag(argv, "--limit") ? Number(flag(argv, "--limit")) : undefined;
  if (!configPath || !goldenPath || !outPath) {
    process.stderr.write(
      "usage: bun eval/search-and-read-cost.ts <config.json> <golden-set> --json <out.json> [--k 10] [--limit N]\n",
    );
    process.exit(2);
  }

  const config = loadConfig(configPath);
  const vault = config.vaults[0];
  if (!vault) throw new Error("config.vaults is empty");
  const golden = GoldenSetSchema.parse(parseYaml(readFileSync(goldenPath, "utf8")));
  const queries = golden.queries.slice(0, limit);

  const provider = createEmbeddingProvider(config.embeddings, {
    excludeFilter: compileEgressFilter(config.egress.excludePaths),
    cacheDir: config.cacheDir,
  });
  const db = await openConfiguredDatabase(config, "cache.db");
  const vaultRegistry = new VaultRegistry([{ id: vault.id, path: vault.path }]);
  const registry = new ToolRegistry({});
  registerM1Tools(registry, {
    vaultRegistry,
    version: "eval",
    startedAt: 0,
    embeddings: { provider: config.embeddings.provider, model: config.embeddings.model },
  });
  registerM7Tools(registry, {
    vaultRegistry,
    embeddingProvider: provider,
    reranker: null,
    roles: null,
    retrieval: config.retrieval,
    ranking: config.ranking,
  });
  const ctx: CallerContext = {
    caller: "eval",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: vault.id,
    db,
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
  };

  const bytesByTool: Record<string, number> = {};
  /** One dispatched call, its request and response measured as the agent would see them. */
  const call = async (cost: Cost, name: string, input: Record<string, unknown>) => {
    const res = await registry.dispatch(name, input, ctx);
    if (!res.ok) throw new Error(`${name} failed: ${JSON.stringify(res.error)}`);
    const req = JSON.stringify(input);
    const out = JSON.stringify(res.data);
    cost.calls += 1;
    cost.request_bytes += Buffer.byteLength(req);
    cost.response_bytes += Buffer.byteLength(out);
    cost.tokens += estimateTokens(req) + estimateTokens(out);
    bytesByTool[name] = (bytesByTool[name] ?? 0) + Buffer.byteLength(out);
    return res.data as Record<string, unknown>;
  };

  const asChunks = (paths: string[]): RankedChunk[] =>
    paths.map((path) => ({ chunk_id: path, path }));
  const perQuery: Array<
    EvalQueryResult & { cost: { control: Cost; treatment: Cost; same: boolean } }
  > = [];

  for (const q of queries) {
    // Control: search, then read_notes over the distinct top-k notes.
    const control = emptyCost();
    const search = await call(control, "vault_graph_search", {
      vault: vault.id,
      query: q.query_text,
      final_top_k: candidatePoolSize(k),
    });
    const controlPaths = [
      ...new Set((search.results as Array<{ path: string }>).map((r) => r.path)),
    ].slice(0, k);
    if (controlPaths.length > 0) {
      let cursor: string | undefined;
      do {
        const page = await call(control, "read_notes", {
          vault: vault.id,
          paths: controlPaths,
          ...(cursor ? { cursor } : {}),
        });
        for (const n of page.notes as Array<{ body: string }>) {
          control.notes += 1;
          control.note_bytes += Buffer.byteLength(n.body);
        }
        cursor = (page.next_cursor as string | null) ?? undefined;
      } while (cursor);
    }

    // Treatment: one search_and_read (following its cursor if the result pages).
    const treatment = emptyCost();
    const treatmentPaths: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await call(treatment, "search_and_read", {
        vault: vault.id,
        query: q.query_text,
        k,
        ...(cursor ? { cursor } : {}),
      });
      for (const n of page.notes as Array<{ path: string; body: string; truncated: boolean }>) {
        treatmentPaths.push(n.path);
        treatment.notes += 1;
        treatment.note_bytes += Buffer.byteLength(n.body);
        if (n.truncated) treatment.truncated += 1;
      }
      cursor = (page.next_cursor as string | null) ?? undefined;
    } while (cursor);

    perQuery.push({
      id: q.id,
      baseline: computeQueryMetrics(q, asChunks(controlPaths)),
      graph: computeQueryMetrics(q, asChunks(treatmentPaths)),
      hard: false,
      z1: 0,
      cost: {
        control,
        treatment,
        same: JSON.stringify(controlPaths) === JSON.stringify(treatmentPaths),
      },
    });
  }

  const sum = (pick: (r: (typeof perQuery)[number]) => Cost): Cost => {
    const t = emptyCost();
    for (const r of perQuery) {
      const c = pick(r);
      for (const key of Object.keys(t) as Array<keyof Cost>) t[key] += c[key];
    }
    return t;
  };
  const control = sum((r) => r.cost.control);
  const treatment = sum((r) => r.cost.treatment);
  const pct = (a: number, b: number): number => (a === 0 ? 0 : Math.round((1 - b / a) * 1000) / 10);
  const summary = {
    queries: perQuery.length,
    k,
    same_paths_in_same_order: perQuery.filter((r) => r.cost.same).length,
    control,
    treatment,
    response_bytes_by_tool: bytesByTool,
    reduction_pct: {
      calls: pct(control.calls, treatment.calls),
      request_bytes: pct(control.request_bytes, treatment.request_bytes),
      response_bytes: pct(control.response_bytes, treatment.response_bytes),
      tokens: pct(control.tokens, treatment.tokens),
    },
    per_query_mean: {
      control_calls: control.calls / perQuery.length,
      treatment_calls: treatment.calls / perQuery.length,
      control_tokens: control.tokens / perQuery.length,
      treatment_tokens: treatment.tokens / perQuery.length,
    },
  };
  writeFileSync(
    outPath,
    `${JSON.stringify({ flags: ["search-and-read-cost", `k=${k}`], summary, perQuery }, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
