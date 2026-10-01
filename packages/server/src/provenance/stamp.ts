// Optional provenance stamps: a copy of what the signed record holds, written where a human will
// see it. Both are OFF by default (`provenance.stamp.*`), and neither adds anything the record does
// not already carry: session, principal, a self-reported model, a seq. Never the host id.
//
//   commit trailers   `Obsidian-TC-*` lines appended to a commit the server makes through the
//                     commit tool, for the recorded writes whose CURRENT bytes are in that commit.
//   frontmatter       one key on a note an agent just CREATED. An existing note is never touched.
//
// Trust is stated in the text itself: the principal is the verified one or the word `unverified`,
// and the model always says `(self-reported)` (a client can claim any model). The record in
// cache.db stays the source of truth; a stamp can be edited by anyone who can edit the note or
// rewrite history.
import type { Database } from "../db/types";
import type { CallerContext } from "../mcp/registry/types";
import { parseNote, serializeNote } from "../vault/frontmatter";
import { digestUnder } from "./digest";
import { verifiedPrincipalOf } from "./recorder";
import { readHeadRow } from "./store";
import type { ProvenanceBody } from "./types";

export interface StampConfig {
  gitTrailers: boolean;
  frontmatter: boolean;
  frontmatterKey: string;
}

/** Newest records read when matching a commit to the writes in it; older ones are out of scope. */
export const MAX_RECORDS_SCANNED = 2000;
/** Distinct values per trailer; more is reported by `Obsidian-TC-Truncated`, never hidden. */
export const MAX_TRAILER_VALUES = 10;

const RESERVED = /^Obsidian-TC-[A-Za-z0-9-]*[ \t]*:/i;
const SHA256 = /^[0-9a-f]{64}$/;
// Control characters, plus the Unicode line/paragraph separators some renderers break lines on.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** One line, no control characters, bounded: a client-supplied value must not be able to end its
 *  own trailer line and start another (`model: "x\nSigned-off-by: ..."`). Undefined when nothing
 *  usable is left. */
function oneLine(v: string | undefined, max = 200): string | undefined {
  if (v === undefined) return undefined;
  const t = v.replace(CONTROL, " ").trim();
  return t.length > 0 ? t.slice(0, max) : undefined;
}

/**
 * Add the stamp to the content of a note that is being CREATED. Every other key keeps its exact
 * source bytes (parse + line-list serialize). The stamp key is reserved on creation: a value the
 * caller supplied under it is replaced, so a forged stamp cannot pass as the server's. Content
 * whose frontmatter is not valid YAML is returned unchanged rather than failing the write.
 */
export function stampFrontmatter(content: string, key: string, stamp: Record<string, unknown>) {
  let note: ReturnType<typeof parseNote>;
  try {
    note = parseNote(content);
  } catch {
    return content;
  }
  return serializeNote(
    { ...(note.frontmatter ?? {}), [key]: stamp },
    note.body,
    note.rawFrontmatter,
    {
      frontmatterEol: note.frontmatterEol,
      frontmatterAtEof: note.frontmatterAtEof,
    },
  );
}

const isTrailerLine = (l: string): boolean => /^[A-Za-z][A-Za-z0-9-]*[ \t]*:/.test(l);
const isContinuation = (l: string): boolean => /^[ \t]+\S/.test(l);

/**
 * Append trailer lines to a commit message the way `git interpret-trailers` would: at the end, in
 * the last paragraph when that is already a trailer block (every line `Key: value`, a continuation
 * line allowed), otherwise in a new paragraph after one blank line. The caller's own text is kept
 * byte for byte, with one exception: any `Obsidian-TC-*` trailer the caller wrote in the final
 * trailer block is dropped, so a trailer under that prefix is always the server's. Spawning git is
 * deliberately avoided (a vault's own config can run programs, see vault/git-state.ts).
 * No lines and nothing to drop returns `message` untouched.
 */
export function applyTrailers(message: string, lines: readonly string[]): string {
  const eol = message.includes("\r\n") ? "\r\n" : "\n";
  const all = message.replace(/\r\n/g, "\n").trimEnd().split("\n");
  let start = all.length;
  while (start > 0 && all[start - 1]?.trim() !== "") start--;
  const last = all.slice(start);
  const hasBlock =
    start > 0 &&
    last.length > 0 &&
    last.every((l, i) => isTrailerLine(l) || (i > 0 && isContinuation(l)));
  let kept = last;
  if (hasBlock) {
    kept = [];
    let dropping = false;
    for (const l of last) {
      if (!isContinuation(l)) dropping = RESERVED.test(l);
      if (!dropping) kept.push(l);
    }
  }
  if (lines.length === 0 && kept.length === last.length) return message;
  let out: string[];
  if (hasBlock) {
    // `head` still ends with the blank line that separated the block from the body.
    const head = all.slice(0, start);
    const trailers = [...kept, ...lines];
    if (trailers.length === 0) while (head[head.length - 1]?.trim() === "") head.pop();
    out = [...head, ...trailers];
  } else {
    out = [...all, "", ...lines];
  }
  return out.join(eol) + (/\n$/.test(message) ? eol : "");
}

/** The caller facts a stamp reads: the same ones the record's `verified`/`self_reported` groups do. */
export type StampCaller = Pick<
  CallerContext,
  "sessionId" | "caller" | "authVerified" | "claimedProvenance"
>;

export interface ProvenanceStamperOptions {
  db: Database;
  config: StampConfig;
  /** Fail-open sink: a stamp that could not be built is skipped, never failing the write. */
  onError?: (what: string, e: unknown) => void;
}

export class ProvenanceStamper {
  constructor(private readonly opts: ProvenanceStamperOptions) {}

  get gitTrailers(): boolean {
    return this.opts.config.gitTrailers;
  }

  get frontmatter(): boolean {
    return this.opts.config.frontmatter;
  }

  /** Where the write's own record will land: one past the newest seq on the vault's chain (the
   *  head's pin when every record was pruned). Exact unless another write to the same vault is
   *  appended first; never above the real seq. */
  private expectedSeq(vaultId: string): number {
    const row = this.opts.db
      .prepare("SELECT MAX(seq) AS s FROM write_provenance WHERE vault_id = ?")
      .get(vaultId) as { s: number | null };
    return (row.s ?? readHeadRow(this.opts.db, vaultId)?.head_seq ?? 0) + 1;
  }

  /** `content` with the stamp added, for a note being CREATED by `ctx`'s call. Unchanged when the
   *  frontmatter stamp is off. Callers pass only creations: an update never reaches this. */
  stampNewNote(content: string, vaultId: string, ctx: StampCaller): string {
    if (!this.opts.config.frontmatter) return content;
    try {
      const session = oneLine(ctx.sessionId);
      const model = oneLine(ctx.claimedProvenance?.model);
      return stampFrontmatter(content, this.opts.config.frontmatterKey, {
        ...(session !== undefined ? { session } : {}),
        principal: oneLine(verifiedPrincipalOf(ctx)) ?? "unverified",
        ...(model !== undefined ? { model_self_reported: model } : {}),
        seq: this.expectedSeq(vaultId),
      });
    } catch (e) {
      this.opts.onError?.("frontmatter", e);
      return content;
    }
  }

  /**
   * Trailer lines for a commit that stages `staged` (repo-relative paths, as the bridge reports
   * them). A staged file counts only when its bytes right now equal what a record says that write
   * left (`after`): a note a human edited since is not attributed to the agent, and a deletion is
   * not attributed at all (`absent` carries no content to match). Of several records for one file
   * the newest matching wins. Empty when no staged file matches, or the stamp is off.
   */
  async commitTrailers(
    vaultId: string,
    root: string | undefined,
    staged: readonly string[],
  ): Promise<string[]> {
    if (!this.opts.config.gitTrailers || staged.length === 0) return [];
    try {
      const matched = await this.matchRecords(vaultId, root, staged);
      return matched.length === 0 ? [] : trailerLines(vaultId, matched);
    } catch (e) {
      this.opts.onError?.("trailers", e);
      return [];
    }
  }

  private async matchRecords(
    vaultId: string,
    root: string | undefined,
    staged: readonly string[],
  ): Promise<ProvenanceBody[]> {
    const rows = this.opts.db
      .prepare("SELECT body FROM write_provenance WHERE vault_id = ? ORDER BY seq DESC LIMIT ?")
      .all(vaultId, MAX_RECORDS_SCANNED) as Array<{ body: string }>;
    const byPath = new Map<string, ProvenanceBody[]>();
    for (const r of rows) {
      let body: ProvenanceBody;
      try {
        body = JSON.parse(r.body) as ProvenanceBody;
      } catch {
        continue;
      }
      for (const p of body.paths) byPath.set(p.path, [...(byPath.get(p.path) ?? []), body]);
    }
    const matched = new Map<number, ProvenanceBody>();
    for (const path of staged) {
      // The repo may sit above the vault: `Vault/a.md` in git is `a.md` in the vault.
      const segs = path.split("/");
      for (let i = 0; i < segs.length; i++) {
        const cand = segs.slice(i).join("/");
        const records = byPath.get(cand);
        if (records === undefined) continue;
        const now = await digestUnder(root, cand);
        if (!SHA256.test(now)) continue;
        const hit = records.find((rec) =>
          rec.paths.some((e) => e.path === cand && e.after === now),
        );
        if (hit !== undefined) {
          matched.set(hit.seq, hit);
          break;
        }
      }
    }
    return [...matched.values()].sort((a, b) => a.seq - b.seq);
  }
}

function trailerLines(vaultId: string, records: ProvenanceBody[]): string[] {
  const distinct = (vals: Array<string | undefined>): string[] => [
    ...new Set(vals.filter((v): v is string => v !== undefined)),
  ];
  const sessions = distinct(records.map((r) => oneLine(r.verified.session_id)));
  const principals = distinct(records.map((r) => oneLine(r.verified.principal) ?? "unverified"));
  const models = distinct(records.map((r) => oneLine(r.self_reported.model)));
  const cap = (vals: string[]): string[] => vals.slice(0, MAX_TRAILER_VALUES);
  const truncated = [sessions, principals, models].some((v) => v.length > MAX_TRAILER_VALUES);
  const first = records[0]?.seq ?? 0;
  const lastSeq = records[records.length - 1]?.seq ?? first;
  return [
    ...cap(sessions).map((s) => `Obsidian-TC-Session: ${s}`),
    ...cap(principals).map((p) => `Obsidian-TC-Principal: ${p}`),
    ...cap(models).map((m) => `Obsidian-TC-Model: ${m} (self-reported)`),
    `Obsidian-TC-Provenance-Seq: ${oneLine(vaultId)}:${first}-${lastSeq}`,
    ...(truncated ? ["Obsidian-TC-Truncated: more values than listed"] : []),
  ];
}
