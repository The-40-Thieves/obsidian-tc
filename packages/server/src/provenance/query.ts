// The read side of write provenance: which records touched ONE note, newest first, as the caller
// is allowed to see them. The tool (tools/m1/provenance-tools.ts) owns the input/output contract;
// this module owns the three things that must not be re-derived there:
//
//   * finding a path's records. `write_provenance` has no path column (the signed body is the only
//     source of truth), so a per-vault scan is prefiltered in SQL on the path's final segment and
//     decided in JS on the normalized path. Stored paths are the ones the call NAMED, so `./a.md`,
//     `dir\a.md` and `a.md` are three spellings of one note; only the normalized form is compared.
//   * following a move backwards (see `resolveLineage`).
//   * masking. A record can name many paths (move, copy, bulk). Every path is normalized and put
//     through the caller's read predicate; a path that fails it is dropped from the record, with no
//     placeholder and no count, so nothing says a hidden path existed.
//
// The read predicate is injected rather than imported: this layer knows records, not ACLs, and the
// tool passes the one choke point the search and link tools filter through (`readableRel`).
import type { Database } from "../db/types";
import { normalizeVaultPath } from "../vault/paths";
import type { ProvenanceRow } from "./store";
import { DIGEST_ABSENT, type PathEntry, type ProvenanceBody } from "./types";

/** Tools whose record lists a move as adjacent `[from, to]` pairs (from first), in the order the
 *  tool's `pathAcl` names them. Anything else that happens to delete one path and create another
 *  is not a move for lineage purposes. */
export const MOVE_TOOLS: ReadonlySet<string> = new Set([
  "move_note",
  "bulk_move_notes",
  "move_attachment",
]);

/** Move hops followed backwards from the queried path; each hop is one more scan of the vault's chain. */
export const MAX_LINEAGE_HOPS = 32;
/** Rows pulled per SQL round trip while scanning. */
const SCAN_BATCH = 200;
const NO_BOUND = Number.MAX_SAFE_INTEGER;

/** A path and the seq range (inclusive) in which a record naming it describes THIS note. */
export interface PathWindow {
  path: string;
  lo: number;
  hi: number;
}

export interface QueryOptions {
  vaultId: string;
  /** Normalized vault-relative path (the caller already proved it readable). */
  path: string;
  readable: (rel: string) => boolean;
  /** Return records with seq below this (a cursor), newest first. */
  beforeSeq?: number | undefined;
  since?: number | undefined;
  until?: number | undefined;
  /** Records wanted; one more is fetched to know whether another page exists. */
  limit: number;
}

export interface VisibleRecord {
  row: ProvenanceRow;
  body: ProvenanceBody;
  /** The path (one of the lineage) this record matched, normalized. */
  matched: string;
  /** Only the entries whose normalized path the caller may read. */
  paths: PathEntry[];
}

export interface QueryResult {
  records: VisibleRecord[];
  hasMore: boolean;
  /** Earlier paths of the same note reached by following moves, readable ones only. */
  previousPaths: string[];
}

const canon = (p: string): string => normalizeVaultPath(p).normalize("NFC");

function safeNormalize(p: unknown): string | undefined {
  if (typeof p !== "string") return undefined;
  try {
    return normalizeVaultPath(p);
  } catch {
    return undefined;
  }
}

/** Substrings of a record body that any record naming `path` must contain: its final segment, in
 *  both Unicode forms, JSON-escaped exactly as the canonical body encodes it. */
function needlesFor(path: string): string[] {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const forms = new Set([base.normalize("NFC"), base.normalize("NFD")]);
  return [...forms].map((b) => JSON.stringify(b).slice(1, -1));
}

function parseBody(row: ProvenanceRow): ProvenanceBody | undefined {
  try {
    const body = JSON.parse(row.body) as ProvenanceBody;
    return Array.isArray(body.paths) ? body : undefined;
  } catch {
    return undefined; // a tampered row: `include_verification` reports it, a query does not guess
  }
}

interface Scan {
  vaultId: string;
  windows: PathWindow[];
  /** seq strictly below this. */
  below: number;
  since?: number | undefined;
  until?: number | undefined;
  /** Body must also contain one of these (move-tool names), when set. */
  toolNeedles?: string[];
}

/** Rows in newest-first batches, lazily, until the caller stops asking. */
function* scanRows(db: Database, scan: Scan): Generator<ProvenanceRow> {
  const win = scan.windows.map(
    (w) =>
      `(seq >= ? AND seq <= ? AND (${needlesFor(w.path)
        .map(() => "instr(body, ?) > 0")
        .join(" OR ")}))`,
  );
  const tools = scan.toolNeedles?.map(() => "instr(body, ?) > 0").join(" OR ");
  const sql = `SELECT vault_id, seq, ts, body, prev_hash, hash, kid, sig FROM write_provenance
    WHERE vault_id = ? AND seq < ? AND (${win.join(" OR ")})
    ${tools !== undefined ? `AND (${tools})` : ""}
    ${scan.since !== undefined ? "AND ts >= ?" : ""} ${scan.until !== undefined ? "AND ts <= ?" : ""}
    ORDER BY seq DESC LIMIT ?`;
  const stmt = db.prepare(sql);
  let below = scan.below;
  for (;;) {
    const params: Array<string | number> = [scan.vaultId, below];
    for (const w of scan.windows) params.push(w.lo, w.hi, ...needlesFor(w.path));
    if (scan.toolNeedles) params.push(...scan.toolNeedles);
    if (scan.since !== undefined) params.push(scan.since);
    if (scan.until !== undefined) params.push(scan.until);
    params.push(SCAN_BATCH);
    const rows = stmt.all(...params) as ProvenanceRow[];
    for (const r of rows) yield r;
    if (rows.length < SCAN_BATCH) return;
    below = (rows.at(-1) as ProvenanceRow).seq;
  }
}

/** The entries (in record order) of `body` whose normalized path is `canonical`. */
const entriesNamed = (body: ProvenanceBody, canonical: string): number[] =>
  body.paths.flatMap((e, i) => {
    const n = safeNormalize(e?.path);
    return n !== undefined && n.normalize("NFC") === canonical ? [i] : [];
  });

/**
 * Follow moves backwards from `path`: when the newest record that moved a file ONTO the path says
 * where it came from, the earlier history of that source belongs to the same note. Each hop's
 * window is `[move seq, upper bound]`, so records of the previous occupant of a path never leak in.
 * The walk stops at the first source the caller cannot read (it must not learn the source exists),
 * at a path nothing was moved onto, or at MAX_LINEAGE_HOPS.
 */
export function resolveLineage(
  db: Database,
  vaultId: string,
  path: string,
  readable: (rel: string) => boolean,
): PathWindow[] {
  const windows: PathWindow[] = [];
  let current = path;
  let hi = NO_BOUND;
  for (let hop = 0; hop <= MAX_LINEAGE_HOPS; hop++) {
    const target = canon(current);
    let found: { seq: number; source: string } | undefined;
    for (const row of scanRows(db, {
      vaultId,
      windows: [{ path: current, lo: 0, hi }],
      below: hi,
      toolNeedles: [...MOVE_TOOLS].map((t) => `"tool":"${t}"`),
    })) {
      const body = parseBody(row);
      if (body === undefined || !MOVE_TOOLS.has(body.tool)) continue;
      for (const i of entriesNamed(body, target)) {
        const dest = body.paths[i];
        const from = body.paths[i - 1];
        // Pairs are `[from, to]`: the destination sits at an odd index, the source just before it.
        if (i % 2 !== 1 || dest === undefined || from === undefined) continue;
        if (dest.after === DIGEST_ABSENT || from.after !== DIGEST_ABSENT) continue;
        if (from.before === DIGEST_ABSENT) continue;
        const source = safeNormalize(from.path);
        if (source !== undefined) found = { seq: row.seq, source };
      }
      if (found !== undefined) break;
    }
    if (found === undefined) {
      windows.push({ path: current, lo: 0, hi });
      return windows;
    }
    windows.push({ path: current, lo: found.seq, hi });
    if (!readable(found.source)) return windows;
    current = found.source;
    hi = found.seq;
  }
  return windows;
}

/** The records touching `path` (and the earlier paths of the same note), newest first, each masked
 *  to what the caller may read. Every window's path is readable (the walk stops at one that is
 *  not), so a returned record always lists at least the path it matched. */
export function queryNoteProvenance(db: Database, opts: QueryOptions): QueryResult {
  const windows = resolveLineage(db, opts.vaultId, opts.path, opts.readable);
  const records: VisibleRecord[] = [];
  let hasMore = false;
  for (const row of scanRows(db, {
    vaultId: opts.vaultId,
    windows,
    below: opts.beforeSeq ?? NO_BOUND,
    since: opts.since,
    until: opts.until,
  })) {
    const body = parseBody(row);
    if (body === undefined) continue;
    const matched = windows.find(
      (w) => row.seq >= w.lo && row.seq <= w.hi && entriesNamed(body, canon(w.path)).length > 0,
    );
    if (matched === undefined) continue;
    const paths = body.paths.flatMap((e) => {
      const n = safeNormalize(e?.path);
      return n !== undefined && opts.readable(n)
        ? [{ path: n, before: e.before, after: e.after }]
        : [];
    });
    if (records.length === opts.limit) {
      hasMore = true;
      break;
    }
    records.push({ row, body, matched: safeNormalize(matched.path) ?? matched.path, paths });
  }
  return {
    records,
    hasMore,
    previousPaths: windows.slice(1).map((w) => w.path),
  };
}
