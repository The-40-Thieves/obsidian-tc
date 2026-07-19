// THE-440 — graph-as-enrichment. Re-embed every chunk with its 1-hop wikilink-neighbor context
// injected into the embedded TEXT (never the display content), IN PLACE on a working copy of the
// index. This isolates the ticket's thesis — "turn the graph into an embedding signal, not a
// separate fused stream" — without re-chunking or re-reading the vault: only WHAT TEXT GETS
// EMBEDDED changes. After it runs, it DROPs vec_chunks so eval/run.ts scores the updated
// chunk_embeddings via the brute-force cosine path (semantic.ts) instead of stale vec0 vectors.
//
// Usage:
//   bun eval/reembed-graph-context.ts <config.json> [titles|titles-headings] [--cap N]
//
// Variants (ticket THE-440, cheap first, no LLM):
//   titles          (a) neighbor NOTE TITLES breadcrumb — "linked: A, B, C"
//   titles-headings (b) neighbor titles + each neighbor's folder/domain as light heading context
import { join } from "node:path";
import { loadConfig } from "../src/config/load";
import { openDatabase } from "../src/db/open";
import { createEmbeddingProvider } from "../src/embeddings";
import { enrichChunkText } from "../src/search/chunk";
import { loadVec } from "../src/search/vec";

// Dropping the vec0 virtual table requires the sqlite-vec module to be registered on the
// connection first (else "no such module: vec0"). loadVec is the same loader semantic.ts uses.
function dropVecChunks(db: { exec: (s: string) => void }): void {
  loadVec(db as never);
  db.exec("DROP TABLE IF EXISTS vec_chunks");
}

const argv = process.argv.slice(2);
const configPath = argv.find((a) => !a.startsWith("--") && a.endsWith(".json"));
const variant = (argv.find((a) => a === "titles" || a === "titles-headings") ?? "titles") as
  | "titles"
  | "titles-headings";
const capIdx = argv.indexOf("--cap");
const CAP = capIdx >= 0 ? Number(argv[capIdx + 1]) : 12;
// --control: leave the champion vectors untouched and ONLY drop vec_chunks, producing the
// brute-force-path control so an A/B differs solely in the embedded text, not vec0-vs-scan.
const CONTROL = argv.includes("--control");
if (!configPath) {
  process.stderr.write(
    "usage: bun eval/reembed-graph-context.ts <config.json> [titles|titles-headings] [--cap N]\n",
  );
  process.exit(2);
}

const titleOf = (p: string): string => (p.split(/[/\\]/).pop() ?? p).replace(/\.md$/i, "");
const domainOf = (p: string): string => {
  const seg = p.split(/[/\\]/);
  return seg.length > 1 ? (seg[0] ?? "") : "";
};

async function main(): Promise<void> {
  const config = loadConfig(configPath as string);
  const vault = config.vaults[0];
  if (!vault) throw new Error("config.vaults is empty");
  const vaultId = vault.id;
  const provider = createEmbeddingProvider(config.embeddings);
  const db = await openDatabase(join(config.cacheDir, "cache.db"));

  if (CONTROL) {
    dropVecChunks(db);
    process.stdout.write(
      "THE-440 control: champion vectors kept, dropped vec_chunks (brute-force cosine path)\n",
    );
    db.close?.();
    return;
  }

  // 1-hop undirected neighbor map from the literal wikilink layer (both stored directions).
  const edges = db
    .prepare(
      "SELECT source_path AS s, target_path AS t FROM vault_edges WHERE vault_id = ? AND edge_type = 'links_to'",
    )
    .all(vaultId) as Array<{ s: string; t: string }>;
  const neigh = new Map<string, Set<string>>();
  const add = (a: string, b: string): void => {
    if (a === b) return;
    let set = neigh.get(a);
    if (!set) {
      set = new Set<string>();
      neigh.set(a, set);
    }
    set.add(b);
  };
  for (const e of edges) {
    add(e.s, e.t);
    add(e.t, e.s);
  }

  const chunks = db
    .prepare(
      "SELECT id, path, headings, content FROM chunks WHERE vault_id = ? ORDER BY path, chunk_index",
    )
    .all(vaultId) as Array<{ id: string; path: string; headings: string; content: string }>;

  // Build the graph-enriched embed text for each chunk. Base = the champion's THE-406 enrichment
  // (title + heading breadcrumb + content); the neighbor line is inserted between the breadcrumb
  // and the content so it reads as context, mirroring the enrichChunkText shape.
  const buildText = (c: (typeof chunks)[number]): string => {
    let headings: string[] = [];
    try {
      headings = JSON.parse(c.headings) as string[];
    } catch {
      headings = [];
    }
    const base = enrichChunkText(c.path, headings, c.content); // "title — crumb\n\ncontent"
    const names = [...(neigh.get(c.path) ?? [])]
      .map(titleOf)
      .filter((n, i, arr) => arr.indexOf(n) === i)
      .sort()
      .slice(0, CAP);
    if (names.length === 0) return base;
    const line =
      variant === "titles-headings"
        ? `linked notes: ${names.join(", ")} (domains: ${[
            ...new Set([...(neigh.get(c.path) ?? [])].map(domainOf).filter(Boolean)),
          ]
            .sort()
            .join(", ")})`
        : `linked notes: ${names.join(", ")}`;
    // splice the neighbor line in after the "title — crumb" first line.
    const nl = base.indexOf("\n\n");
    return nl >= 0 ? `${base.slice(0, nl)}\n${line}${base.slice(nl)}` : `${line}\n\n${base}`;
  };

  const texts = chunks.map(buildText);
  process.stdout.write(
    `THE-440 re-embed: ${chunks.length} chunks, variant=${variant}, neighbor cap=${CAP}, ` +
      `${[...neigh.keys()].length} notes carry edges\n`,
  );

  // Embed in batches (document side — matches how the champion index was built) and update the
  // active nomic embedding blob (raw little-endian float32, the format semantic.ts brute-force reads).
  const model = `${config.embeddings.provider}:${config.embeddings.model}`;
  const upd = db.prepare(
    "UPDATE chunk_embeddings SET embedding = ?, generated_at = ? WHERE chunk_id = ? AND model = ?",
  );
  const BATCH = config.embeddings.batchSize ?? 16;
  let done = 0;
  const now = Date.now();
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const vecs = await provider.embed(slice, { input: "document" });
    // The wrapper has no .transaction(); a manual BEGIN/COMMIT batches the writes.
    db.exec("BEGIN");
    try {
      for (let j = 0; j < slice.length; j++) {
        const v = vecs[j];
        const c = chunks[i + j];
        if (!v || !c) continue;
        const buf = Buffer.from(new Float32Array(v).buffer);
        upd.run(buf, now, c.id, model);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    done += slice.length;
    if (done % 800 === 0 || done === texts.length) {
      process.stdout.write(`  embedded ${done}/${texts.length}\n`);
    }
  }

  // Force the eval onto the brute-force cosine path over the UPDATED chunk_embeddings: drop the
  // vec0 index (its vectors are the stale champion ones). tableExists("vec_chunks") then goes false.
  dropVecChunks(db);
  process.stdout.write("dropped vec_chunks (eval now scores updated chunk_embeddings)\n");
  db.close?.();
}

void main();
