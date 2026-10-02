// Shared fixture for the wiki checks (find_existing_page, lint_wiki): a real temp vault, the M7
// tools registered over it, a stub embedding provider whose vectors the test controls, and helpers
// to seed note-level vectors and to prove a call wrote nothing.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import type { Database } from "../src/db/types";
import type { EgressFilter } from "../src/plane/egress-filter";
import type { GatewayRoles } from "../src/plane/gateway";
import { floatBlob } from "../src/search/vec";
import { registerM7Tools } from "../src/tools/m7";
import type { WikiJudgeSettings } from "../src/tools/m7/knowledge/wiki-judge";
import { makeTestVault, type TestVault, type TestVaultOptions } from "./m1-helpers";

export const MODEL = "stub:4";

export interface WikiHarness {
  v: TestVault;
  /** Seed one chunk with a 4-d vector for `path` (a note's vector is the mean of its chunks). */
  seed(path: string, vec: number[], extra?: { id?: string; bodySha?: string }): void;
  call(name: string, input: Record<string, unknown>): Promise<ToolResult>;
  data(name: string, input: Record<string, unknown>): Promise<Record<string, any>>;
}

export function makeWikiHarness(
  opts: TestVaultOptions & {
    vectors?: Record<string, number[]>;
    edb?: Database;
    failEmbed?: boolean;
    roles?: GatewayRoles | null;
    wikiJudge?: Partial<WikiJudgeSettings>;
    excludeFilter?: EgressFilter;
  } = {},
): WikiHarness {
  const {
    vectors = {},
    edb,
    failEmbed = false,
    roles = null,
    wikiJudge,
    excludeFilter,
    ...vaultOpts
  } = opts;
  const v = makeTestVault(vaultOpts);
  registerM7Tools(v.registry, {
    vaultRegistry: v.vaultRegistry,
    embeddingProvider: {
      id: MODEL,
      provider: "stub",
      model: "stub",
      dimensions: 4,
      embed: async (texts: string[]) => {
        if (failEmbed) throw new Error("provider down");
        return texts.map((t) => vectors[t] ?? [0, 0, 0, 0]);
      },
    } as any,
    reranker: null,
    roles,
    ...(excludeFilter ? { excludeFilter } : {}),
    ...(wikiJudge
      ? {
          wikiJudge: {
            enabled: true,
            maxCallsPerRequest: 3,
            maxCallsPerDay: 200,
            timeoutMs: 2000,
            maxNoteChars: 2400,
            ...wikiJudge,
          },
        }
      : {}),
    ...(edb ? { edb } : {}),
  });
  let n = 0;
  const seed: WikiHarness["seed"] = (path, vec, extra) => {
    const id = extra?.id ?? `c${++n}`;
    v.db
      .prepare(
        `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at, body_sha)
         VALUES (?, 'test', ?, '0', '[]', ?, ?, 1, 0, 0, ?)`,
      )
      .run(id, path, `body of ${path}`, `h-${id}`, extra?.bodySha ?? `sha-${id}`);
    v.db
      .prepare(
        `INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at)
         VALUES (?, ?, 4, ?, 1, 0)`,
      )
      .run(id, MODEL, floatBlob(vec));
  };
  const call: WikiHarness["call"] = (name, input) => v.call(name, { vault: "test", ...input });
  const data: WikiHarness["data"] = async (name, input) => {
    const r = await call(name, input);
    if (!r.ok) throw new Error(`${name} failed: ${JSON.stringify(r.error)}`);
    return r.data as Record<string, any>;
  };
  return { v, seed, call, data };
}

/** sha256 of every file under `root`, keyed by relative path: equal before/after == nothing written. */
export function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, r);
      else out[r] = createHash("sha256").update(readFileSync(abs)).digest("hex");
    }
  };
  walk(root, "");
  return out;
}

/** Row counts of the tables a lint/find call could conceivably touch. */
export function dbCounts(db: Database): Record<string, number> {
  const tables = ["chunks", "chunk_embeddings", "contradictions", "notes", "chunk_retrievals"];
  const out: Record<string, number> = {};
  for (const t of tables) {
    try {
      out[t] = (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    } catch {
      out[t] = -1;
    }
  }
  return out;
}
