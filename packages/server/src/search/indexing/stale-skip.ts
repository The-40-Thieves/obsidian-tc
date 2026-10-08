// GH #1160: what an indexVault stale-plan skip reports. The skip used to assert one cause ("a
// concurrent write_note/watcher commit") whatever had actually differed, and it fired identically on
// every pass for 1,223 of 1,501 notes of a vault where nothing was writing — a chunk carrying two
// ACTIVE embeddings makes `LEFT JOIN chunk_embeddings ... is_active = 1` return an arbitrary row, so
// two reads of the same path disagree on active_model. This reports the difference it observed,
// names the more-than-one-active case, and says so when a skip repeats unchanged across passes
// (a persistent state fault, not a race).
import type { Database } from "../../db/types";
import type { ExistingRow } from "./types";

/** path -> last pass's difference text, per database, so an identical repeat can be recognised. */
const lastPassSkips = new WeakMap<Database, Map<string, string>>();

const short = (id: string): string => id.slice(0, 12);

/** One sentence naming how `current` differs from the snapshot a plan was computed against. */
export function describeRowDifference(planned: ExistingRow[], current: ExistingRow[]): string {
  const cur = new Map(current.map((r) => [r.id, r]));
  const plan = new Map(planned.map((r) => [r.id, r]));
  // A chunk listed twice in one read is the LEFT JOIN fanning out over >1 active embedding.
  if (planned.length !== plan.size || current.length !== cur.size)
    return "a chunk is listed more than once (the active-embedding join returned several rows)";
  const gone = planned.filter((r) => !cur.has(r.id)).length;
  const added = current.filter((r) => !plan.has(r.id)).length;
  if (gone > 0 || added > 0) return `${gone} chunk(s) removed and ${added} added since planning`;
  for (const p of planned) {
    const c = cur.get(p.id);
    if (c === undefined) continue;
    if (c.active_model !== p.active_model)
      return `chunk ${short(p.id)}: active_model was ${JSON.stringify(p.active_model)} when planned, now ${JSON.stringify(c.active_model)}`;
    if (c.content_hash !== p.content_hash)
      return `chunk ${short(p.id)}: content_hash changed since planning`;
  }
  return "chunk rows differ from the planned snapshot";
}

/** Chunks of `path` carrying more than one active embedding, with the models involved. */
function multiActiveChunks(
  db: Database,
  vaultId: string,
  path: string,
): Array<{ chunk_id: string; models: string }> {
  try {
    return db
      .prepare(
        `SELECT e.chunk_id AS chunk_id, GROUP_CONCAT(e.model, ', ') AS models
           FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id
          WHERE c.vault_id = ? AND c.path = ? AND e.is_active = 1
          GROUP BY e.chunk_id HAVING COUNT(*) > 1`,
      )
      .all(vaultId, path) as Array<{ chunk_id: string; models: string }>;
  } catch {
    return []; // a bare/pre-migration fixture without the tables — nothing to name
  }
}

export interface StaleSkipLog {
  /** The path's chunk rows no longer match the plan's snapshot. */
  rowMismatch(path: string, planned: ExistingRow[], current: ExistingRow[]): void;
  /** note_write_fence: a fresher commit or deindex tombstone landed first (genuinely concurrent). */
  fenceDropped(path: string): void;
  /** The stderr text for this flush, or undefined when nothing was skipped. */
  report(): string | undefined;
}

export function createStaleSkipLog(db: Database, vaultId: string): StaleSkipLog {
  const entries: Array<{ path: string; why: string; multi: string | undefined }> = [];
  return {
    rowMismatch(path, planned, current) {
      const multi = multiActiveChunks(db, vaultId, path)[0];
      entries.push({
        path,
        why: describeRowDifference(planned, current),
        multi: multi && `chunk ${short(multi.chunk_id)} has active embeddings for ${multi.models}`,
      });
    },
    fenceDropped(path) {
      entries.push({
        path,
        why: "a fresher commit or deindex landed first (write fence)",
        multi: undefined,
      });
    },
    report() {
      if (entries.length === 0) return undefined;
      const prior = lastPassSkips.get(db) ?? new Map<string, string>();
      lastPassSkips.set(db, prior);
      const repeated = entries.filter((e) => prior.get(`${vaultId}\0${e.path}`) === e.why);
      for (const e of entries) prior.set(`${vaultId}\0${e.path}`, e.why);
      const multi = entries.filter((e) => e.multi !== undefined);
      const sample = entries
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.why}`)
        .join("; ");
      let msg =
        `[index] vault "${vaultId}": ${entries.length} note(s) skipped this pass — their chunk rows ` +
        `no longer matched the snapshot the plan was computed against (${sample}` +
        `${entries.length > 3 ? "; ..." : ""}).`;
      if (multi.length > 0)
        msg +=
          ` ${multi.length} of them carry MORE THAN ONE ACTIVE embedding (${multi[0]?.multi}): a ` +
          `data-integrity fault, not a concurrent write — run \`obsidian-tc doctor\` (GH #1160).`;
      else if (repeated.length > 0)
        msg +=
          ` ${repeated.length} of them were skipped before with this identical difference; a concurrent ` +
          `write would not repeat identically, so suspect a persistent state fault (run \`obsidian-tc doctor\`).`;
      else
        msg +=
          " A concurrent write_note/watcher commit is the usual cause; the next index_vault re-plans them.";
      return `${msg}\n`;
    },
  };
}
