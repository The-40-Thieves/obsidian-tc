// Note-level vectors and the near-duplicate pair scan over them. READ-ONLY: this only reads
// `chunks` and `chunk_embeddings`; it never writes and never embeds.
//
// A note's vector is the L2-normalised MEAN of its active chunk embeddings (for the model that is
// currently serving). Notes with no vector (excluded from the index, embedding withheld by
// `egress.excludePaths`, not yet embedded) are simply absent: a note that is not in the index can
// never be a search-derived candidate. That is the property the wiki checks rely on for Obsidian's
// Excluded files.

import type { Database } from "../db/types";
import { cosineBatch } from "./native";
import { blobToFloats } from "./vec";

export interface NoteVectors {
  dim: number;
  /** Note paths, parallel to the rows of `flat`. */
  paths: string[];
  /** `paths.length * dim` floats, row-major, each row unit length. */
  flat: Float32Array;
  /** True when more notes had vectors than `maxNotes` allowed, so the tail was not loaded. */
  truncated: boolean;
}

export interface NoteVectorOptions {
  /** The serving embedding model (`provider.id`); other models' vectors are never mixed in. */
  model: string;
  /** Only notes under this folder (vault-relative, no trailing slash needed). */
  folder?: string | undefined;
  /** Per-note admission (read ACL, index exclusion). Called once per distinct path. */
  include?: ((path: string) => boolean) | undefined;
  /** Hard cap on notes loaded; the scan is O(n^2) in this. */
  maxNotes: number;
}

const PAGE = 2000;

export function loadNoteVectors(
  db: Database,
  vaultId: string,
  opts: NoteVectorOptions,
): NoteVectors {
  const folder = opts.folder?.replace(/\/+$/, "");
  const lo = folder ? `${folder}/` : "";
  const hi = folder ? `${folder}/￿` : "￿";
  const sums = new Map<string, { sum: Float32Array; n: number }>();
  const admitted = new Map<string, boolean>();
  let dim = 0;
  let afterPath = "";
  let afterId = "";
  let truncated = false;
  const page = db.prepare(
    `SELECT c.path AS path, c.id AS id, e.embedding AS embedding
     FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.is_active = 1 AND e.model = ?
     WHERE c.vault_id = ? AND c.path >= ? AND c.path < ? AND (c.path, c.id) > (?, ?)
     ORDER BY c.path, c.id LIMIT ${PAGE}`,
  );
  paging: for (;;) {
    const rows = page.all(
      opts.model,
      vaultId,
      lo,
      hi,
      afterPath || lo,
      afterPath ? afterId : "",
    ) as Array<{
      path: string;
      id: string;
      embedding: Uint8Array;
    }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      let ok = admitted.get(r.path);
      if (ok === undefined) {
        ok = opts.include ? opts.include(r.path) : true;
        admitted.set(r.path, ok);
      }
      if (!ok) continue;
      const v = blobToFloats(r.embedding);
      if (v.length === 0) continue;
      if (dim === 0) dim = v.length;
      if (v.length !== dim) continue;
      let acc = sums.get(r.path);
      if (!acc) {
        if (sums.size >= opts.maxNotes) {
          // Paths arrive sorted, so everything after the first overflow is overflow too.
          truncated = true;
          break paging;
        }
        acc = { sum: new Float32Array(dim), n: 0 };
        sums.set(r.path, acc);
      }
      for (let i = 0; i < dim; i++) acc.sum[i] = (acc.sum[i] ?? 0) + (v[i] ?? 0);
      acc.n++;
    }
    const last = rows[rows.length - 1];
    if (!last || rows.length < PAGE) break;
    afterPath = last.path;
    afterId = last.id;
  }
  const paths = [...sums.keys()].sort();
  const flat = new Float32Array(paths.length * dim);
  paths.forEach((p, row) => {
    const acc = sums.get(p);
    if (!acc) return;
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += (acc.sum[i] ?? 0) ** 2;
    const scale = norm > 0 ? 1 / Math.sqrt(norm) : 0;
    for (let i = 0; i < dim; i++) flat[row * dim + i] = (acc.sum[i] ?? 0) * scale;
  });
  return { dim, paths, flat, truncated };
}

export interface NotePair {
  a: string;
  b: string;
  score: number;
}

/** Every pair of notes whose cosine is at least `min`, strongest first, at most `limit` of them.
 *  O(n^2) in `nv.paths.length`; the caller bounds that through `maxNotes`. */
export function nearDuplicatePairs(nv: NoteVectors, min: number, limit: number): NotePair[] {
  const { dim, paths, flat } = nv;
  const out: NotePair[] = [];
  for (let i = 0; i < paths.length - 1; i++) {
    const query = flat.subarray(i * dim, (i + 1) * dim);
    const rest = flat.subarray((i + 1) * dim);
    const scores = cosineBatch(query, rest, dim);
    for (let k = 0; k < scores.length; k++) {
      const s = scores[k] ?? 0;
      if (s >= min) out.push({ a: paths[i] as string, b: paths[i + 1 + k] as string, score: s });
    }
  }
  out.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  return out.slice(0, limit);
}

/** The notes whose vector is closest to `query`, strongest first (cosine; `query` need not be unit). */
export function nearestNotes(
  nv: NoteVectors,
  query: Float32Array,
  k: number,
): Array<{ path: string; score: number }> {
  if (nv.paths.length === 0 || query.length !== nv.dim) return [];
  const scores = cosineBatch(query, nv.flat, nv.dim);
  return nv.paths
    .map((path, i) => ({ path, score: scores[i] ?? 0 }))
    .sort((x, y) => y.score - x.score || x.path.localeCompare(y.path))
    .slice(0, k);
}
