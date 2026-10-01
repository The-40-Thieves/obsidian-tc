// The read side of write provenance: which records touched ONE note, newest first, as the caller
// is allowed to see them. The tool (tools/m1/provenance-tools.ts) owns the input/output contract;
// this module owns the things that must not be re-derived there:
//
//   * finding a path's records. `write_provenance` has no path column (the signed body is the only
//     source of truth, and a stored path is the spelling the call NAMED: `./a.md`, `dir\a.md` and
//     `a.md` are three spellings of one note), so the scan prefilters in SQL on the path's final
//     segment and decides in JS on the normalized path. An indexed path column would need a
//     normalized path computed at write time and a backfill SQL cannot do, so it is deliberately not
//     added: the cost is bounded instead (below).
//   * following a move backwards, in the SAME pass, and only through a move record that verifies.
//   * masking. A record can name many paths (move, copy, bulk). Every path is normalized and put
//     through the caller's read predicate; a path that fails it is dropped from the record, with no
//     placeholder and no count, and nothing derived from the dropped path (the record hash covers
//     it, so the stored hash is withheld too: see `visibleHash`).
//
// COST. One query is ONE newest-first pass over the vault's chain, in seq ranges of SEQ_SPAN rows,
// and examines at most `maxScanRows` rows (default DEFAULT_MAX_SCAN_ROWS). Each examined row is an
// `instr` over its body (~0.5 KB), so the default is a few hundred ms in the worst case, and a chain
// shorter than the budget is never truncated. A hop to an earlier path re-examines at most one
// range. Past the budget the pass stops and the result says `scanTruncated`: what it found is
// real, older history was not looked at.
//
// The read predicate is injected rather than imported: this layer knows records, not ACLs, and the
// tool passes the one choke point the search and link tools filter through (`readableRel`).
import type { Database } from "../db/types";
import { canonicalJson } from "../hash";
import { normalizeVaultPath } from "../vault/paths";
import type { KeyResolver } from "./signer";
import { type ProvenanceRow, sha256Hex } from "./store";
import { DIGEST_ABSENT, type PathEntry, type ProvenanceBody } from "./types";
import { type ProblemCode, verifyRecordAt } from "./verify";

/** Tools whose record lists a move as adjacent `[from, to]` pairs (from first), in the order the
 *  tool's `pathAcl` names them. Anything else that happens to delete one path and create another
 *  is not a move for lineage purposes. */
export const MOVE_TOOLS: ReadonlySet<string> = new Set([
  "move_note",
  "bulk_move_notes",
  "move_attachment",
]);

/** Move hops followed backwards from the queried path. */
export const MAX_LINEAGE_HOPS = 32;
/** Rows one query may examine when the config does not say (`provenance.query.maxScanRows`). */
export const DEFAULT_MAX_SCAN_ROWS = 100_000;
/** Seqs covered per SQL round trip; also the most a hop to an earlier path re-examines. */
const SEQ_SPAN = 256;

/** Why the walk back through moves stopped at a record it could not trust or follow. */
export type LineageStop = ProblemCode | "unverifiable" | "max_hops";

export interface QueryOptions {
  vaultId: string;
  /** Normalized vault-relative path (the caller already proved it readable). */
  path: string;
  readable: (rel: string) => boolean;
  /** The registry's public keys. Absent (no registry: stdio-only) means no signature can be
   *  checked, which makes a SIGNED move unverifiable and an unsigned one the norm. */
  resolveKey?: KeyResolver | undefined;
  /** Return records with seq below this (a cursor), newest first. */
  beforeSeq?: number | undefined;
  since?: number | undefined;
  until?: number | undefined;
  /** Records wanted; one more is fetched to know whether another page exists. */
  limit: number;
  /** Row budget for this query. */
  maxScanRows?: number | undefined;
}

export interface VisibleRecord {
  row: ProvenanceRow;
  body: ProvenanceBody;
  /** The path (one of the lineage) this record matched, normalized. */
  matched: string;
  /** Only the entries whose normalized path the caller may read. */
  paths: PathEntry[];
  /** At least one path of the record was dropped for this caller. */
  redacted: boolean;
  /** The stored hash when nothing was dropped; otherwise a hash of the visible view only. */
  hash: string;
}

export interface QueryResult {
  records: VisibleRecord[];
  hasMore: boolean;
  /** Earlier paths of the same note reached by following moves, readable ones only. */
  previousPaths: string[];
  /** The row budget ran out before the chain did: older history was not examined. */
  scanTruncated: boolean;
  /** The walk back through moves stopped at a record that failed verification (or the hop cap). */
  lineageIncomplete?: { reason: LineageStop; seq: number } | undefined;
  /** Rows examined (the budget's unit). */
  rowsExamined: number;
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

/** The entries (in record order) of `body` whose normalized path is `canonical`. */
const entriesNamed = (body: ProvenanceBody, canonical: string): number[] =>
  body.paths.flatMap((e, i) => {
    const n = safeNormalize(e?.path);
    return n !== undefined && n.normalize("NFC") === canonical ? [i] : [];
  });

/** Where a move record says the file at `named` (its destination entries) came from, if it is a
 *  well-formed `[from, to]` pair: the source gone, the destination now holding bytes. */
function moveSource(body: ProvenanceBody, named: number[]): string | undefined {
  if (!MOVE_TOOLS.has(body.tool)) return undefined;
  let source: string | undefined;
  for (const i of named) {
    const dest = body.paths[i];
    const from = body.paths[i - 1];
    // Pairs are `[from, to]`: the destination sits at an odd index, the source just before it.
    if (i % 2 !== 1 || dest === undefined || from === undefined) continue;
    if (dest.after === DIGEST_ABSENT || from.after !== DIGEST_ABSENT) continue;
    if (from.before === DIGEST_ABSENT) continue;
    source = safeNormalize(from.path) ?? source;
  }
  return source;
}

/**
 * Why a move record may NOT be followed, or undefined when it may. A record in the table is only
 * evidence if it verifies, so the same per-record check `get_provenance`'s include_verification and
 * the chain verifier use (`verifyRecordAt`) runs before the walk trusts the source it names. With
 * no key registry a signed record cannot be vouched for ("unverifiable") and an unsigned one is
 * the norm; WITH a registry an unsigned row is a row nobody signed, so it is not followed.
 * `head_untrusted` is a note about the chain head, not about this record's content.
 */
function edgeProblem(
  db: Database,
  row: ProvenanceRow,
  resolveKey: KeyResolver | undefined,
): LineageStop | undefined {
  const { problems, signed } = verifyRecordAt(db, row, resolveKey ?? (() => undefined));
  if (signed && resolveKey === undefined) return "unverifiable";
  for (const p of problems) {
    if (p.code === "head_untrusted") continue;
    if (p.code === "unsigned" && resolveKey === undefined) continue;
    return p.code;
  }
  return undefined;
}

/** What the caller may see of a record whose paths were masked, as a hash. The stored hash covers
 *  every path, so handing it out would let a caller test a guess at a hidden path by rebuilding the
 *  body; this one covers the visible view only, so it carries nothing about what was dropped. */
function viewHash(body: ProvenanceBody, paths: PathEntry[]): string {
  const { v, vault, seq, ts, tool, outcome, verified, unauthenticated, self_reported } = body;
  return sha256Hex(
    canonicalJson({
      v,
      vault,
      seq,
      ts,
      tool,
      outcome,
      paths,
      verified,
      unauthenticated: unauthenticated ?? {},
      self_reported: self_reported ?? {},
    }),
  );
}

function visible(
  row: ProvenanceRow,
  body: ProvenanceBody,
  matched: string,
  readable: (rel: string) => boolean,
): VisibleRecord {
  const paths = body.paths.flatMap((e) => {
    const n = safeNormalize(e?.path);
    return n !== undefined && readable(n) ? [{ path: n, before: e.before, after: e.after }] : [];
  });
  const redacted = paths.length !== body.paths.length;
  return {
    row,
    body,
    matched,
    paths,
    redacted,
    hash: redacted ? viewHash(body, paths) : row.hash,
  };
}

/**
 * The records touching `path` (and the earlier paths of the same note), newest first, each masked
 * to what the caller may read, in one bounded pass (see COST above).
 *
 * Moves are followed backwards while scanning: a move record that names the current path as its
 * destination, and that VERIFIES, hands the walk over to its source from that seq down, so records
 * of the path's previous occupant never leak in. The walk stops, silently, at the first source the
 * caller cannot read (it must not learn the source exists); and loudly (`lineageIncomplete`) at a
 * move record that fails verification, whose source is then not followed and whose earlier history
 * is not returned. Every returned window's path is readable, so a returned record always lists at
 * least the path it matched.
 */
export function queryNoteProvenance(db: Database, opts: QueryOptions): QueryResult {
  const budget = opts.maxScanRows ?? DEFAULT_MAX_SCAN_ROWS;
  const bounds = db
    .prepare("SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM write_provenance WHERE vault_id = ?")
    .get(opts.vaultId) as { lo: number | null; hi: number | null };
  const records: VisibleRecord[] = [];
  const paths: string[] = [opts.path];
  let hasMore = false;
  let scanTruncated = false;
  let lineageIncomplete: QueryResult["lineageIncomplete"];
  let examined = 0;
  if (bounds.lo !== null && bounds.hi !== null) {
    const floor = bounds.lo;
    let current = opts.path;
    let target = canon(current);
    let needles = needlesFor(current);
    const stmtFor = (n: string[]) =>
      db.prepare(
        `SELECT vault_id, seq, ts, body, prev_hash, hash, kid, sig FROM write_provenance
         WHERE vault_id = ? AND seq >= ? AND seq < ?
           AND (${n.map(() => "instr(body, ?) > 0").join(" OR ")})
         ORDER BY seq DESC`,
      );
    let stmt = stmtFor(needles);
    let below = bounds.hi + 1;
    let stop = false;
    while (!stop && below > floor) {
      if (examined >= budget) {
        scanTruncated = true;
        break;
      }
      const lo = Math.max(floor, below - SEQ_SPAN, below - (budget - examined));
      examined += below - lo;
      const rows = stmt.all(opts.vaultId, lo, below, ...needles) as ProvenanceRow[];
      let hopped = false;
      for (const row of rows) {
        const body = parseBody(row);
        if (body === undefined) continue;
        const named = entriesNamed(body, target);
        if (named.length === 0) continue;
        const inPage =
          (opts.beforeSeq === undefined || row.seq < opts.beforeSeq) &&
          (opts.since === undefined || row.ts >= opts.since) &&
          (opts.until === undefined || row.ts <= opts.until);
        if (inPage) {
          if (records.length === opts.limit) {
            hasMore = true;
            stop = true;
            break;
          }
          records.push(visible(row, body, current, opts.readable));
        }
        const source = moveSource(body, named);
        if (source === undefined) continue;
        const bad = edgeProblem(db, row, opts.resolveKey);
        if (bad !== undefined) {
          lineageIncomplete = { reason: bad, seq: row.seq };
          stop = true;
          break;
        }
        if (!opts.readable(source)) {
          stop = true;
          break;
        }
        if (paths.length > MAX_LINEAGE_HOPS) {
          lineageIncomplete = { reason: "max_hops", seq: row.seq };
          stop = true;
          break;
        }
        paths.push(source);
        current = source;
        target = canon(source);
        needles = needlesFor(source);
        stmt = stmtFor(needles);
        below = row.seq;
        hopped = true;
        break;
      }
      if (!hopped && !stop) below = lo;
    }
  }
  return {
    records,
    hasMore,
    previousPaths: paths.slice(1),
    scanTruncated,
    lineageIncomplete,
    rowsExamined: examined,
  };
}
