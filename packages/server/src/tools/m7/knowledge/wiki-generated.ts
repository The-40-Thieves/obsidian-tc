// The wiki folder's two generated pages: `index.md` (the pages grouped by their SCHEMA.md type) and
// `log.md` (an append-only projection of write_provenance for the folder). The server writes them,
// not the caller and not an LLM, from commit_wiki_page and from the maintenance scheduler; both
// carry `generated_by: obsidian-tc` in their frontmatter so a human or an LLM can tell.
//
// Rules, each one a test in test/wiki-generated.test.ts:
//   * Reads. What is listed is what a caller holding NO rule-scopes may read under the vault's ACL,
//     minus Obsidian's Excluded files. The pages are one shared file, so they are built for the
//     least-privileged reader, never for whoever happened to trigger the write; the scheduler and
//     the tool therefore produce the same bytes. Page text is never copied in: only the link, and
//     a `type` value that is plain words (else it is grouped under "(other)").
//   * Names. A page path is untrusted text (a VaultPath only refuses `..` and an absolute path), so
//     every path, stem and label written is stripped of control, format and line/paragraph
//     separator characters first: one page is one line, and bidi marks cannot reorder it.
//   * Aliases. A path is listed only when `callerCanReadVaultPath` says a scopeless reader may read
//     it, which resolves symlinks first, and Excluded files are tested on the resolved path too.
//   * Attribution. Each log line carries the principal, model and tool, which get_provenance gates
//     behind read:provenance. So reading `log.md` needs that scope too: an implicit per-path
//     rule-scope on it (wiki-log-acl.ts), enforced by every read surface. The server's own write
//     holds exactly that scope; its own read of the file is a plain fs read, not a caller read.
//   * Writes. Only where the vault ACL allows a write to that path with NO rule-scopes held (a
//     read-only vault is never touched), through the same checks and atomic writer as a page, with
//     a snapshot of what it replaces, and no confirmation. They are not sent to the index: dedupe
//     and lint ignore them.
//   * Hand edits. A keyed frontmatter HMAC seals the file. A file that is not sealed by us (someone's own
//     index.md) or whose bytes no longer match the seal is LEFT ALONE and reported, never
//     overwritten; delete it (restore_note keeps a copy) and the next pass regenerates it. An edit
//     that lands while the page is being rebuilt is caught by the write batch's compare-and-swap
//     (the bytes are hashed again right before the rename). Residual, as vault/write-batch.ts says:
//     POSIX has no conditional rename, so an edit between that hash and the rename is still lost
//     (the snapshot of the replaced bytes is not of that edit).
//   * Failure. Nothing here throws: a failure is a warning for the scheduler or queued worker to log.
import { ObsidianTcError, type VaultMemoryDefenseConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { FolderAcl } from "../../../acl";
import type { Database } from "../../../db/types";
import { enforceMemoryDefenseOnNoteWrite } from "../../../experiential/memory-defense";
import { sanitizeDisplayText } from "../../../mcp/elicit-form";
import type { MetricsRecorder } from "../../../metrics/registry";
import type { VaultExclusion } from "../../../search/index-exclusion";
import { callerCanReadVaultPath, enforcePathAcl } from "../../../vault/acl-path";
import { parseNoteLenient } from "../../../vault/frontmatter";
import { noteExists, readNote, readNoteBounded } from "../../../vault/notes-io";
import {
  normalizeVaultPath,
  resolveVaultPath,
  resolveVaultPathChecked,
} from "../../../vault/paths";
import {
  captureSnapshot,
  discardSnapshots,
  pruneSnapshots,
  type SnapshotCaptureConfig,
} from "../../../vault/snapshots";
import { applyWriteBatch } from "../../../vault/write-batch";
import { readableNotes, type ScanScope } from "../../wiki-scan";
import {
  assertWikiPagePath,
  isGeneratedWikiPath,
  pathInFolder,
  WIKI_INDEX_FILE,
  WIKI_LOG_FILE,
} from "./wiki-folder";
import { blankHash, inspectGenerated, seal } from "./wiki-generated-seal";
import { WIKI_LOG_SCOPE } from "./wiki-log-acl";
import { loadWikiSchema, WIKI_SCHEMA_FILE, WIKI_TYPE_KEY } from "./wiki-schema";

export { isGeneratedPage } from "./wiki-generated-seal";
export { isGeneratedWikiPath, WIKI_INDEX_FILE, WIKI_LOG_FILE };

export interface WikiGenerateEnv {
  root: string;
  vaultId: string;
  wikiFolder: string | undefined;
  /** The vault's ACL (no caller: see the header for why reads use no rule-scopes). */
  acl: FolderAcl | undefined;
  exclusion: VaultExclusion;
  /** cache.db: the snapshots and the write_provenance chain. */
  db: Database;
  snapshots?: SnapshotCaptureConfig | undefined;
  memoryDefense?: VaultMemoryDefenseConfig | undefined;
  metrics?: MetricsRecorder | undefined;
  now?: () => number;
  /** Per-server HMAC key loaded from the cache/state directory. */
  sealKey: string;
}

export interface GeneratedWarning {
  path: string;
  /** `edited`: sealed by us, bytes changed since; `foreign`: not ours; `denied`: the ACL forbids the
   *  write; `failed`: could not write. */
  kind: "edited" | "foreign" | "denied" | "failed";
  message: string;
}

export interface WikiGenerateResult {
  written: string[];
  warnings: GeneratedWarning[];
}

/** Provenance rows projected per pass; the rest follow on the next one (`last_seq` says where). */
export const LOG_ROWS_PER_PASS = 2000;
/** Pages listed in the index; a larger wiki is cut with a note. */
export const INDEX_MAX_PAGES = 5000;
const NO_TYPE = "(no type)";
const OTHER_TYPE = "(other)";
const SCOPELESS: readonly string[] = [];

const frontmatterFor = (
  page: "index" | "log",
  identity: { vaultId: string; path: string },
  extra = "",
): string =>
  `---\ngenerated_by: obsidian-tc\ngenerated_page: ${page}\ngenerated_vault: ${JSON.stringify(identity.vaultId)}\ngenerated_path: ${JSON.stringify(identity.path)}\n${extra}generated_hash: \n---\n`;

const NOTICE = (what: string): string =>
  `<!-- Generated by obsidian-tc from ${what}. Do not edit by hand: a hand edit stops it being regenerated and lint_wiki reports it. -->`;

/** A page path as text for a generated file: no control, format or line/paragraph separator
 *  character, so it is one line and cannot reorder what is around it. The same sanitiser the
 *  elicitation form uses; there is no length cap (a path is bounded by the filesystem). */
const plainPath = (rel: string): string => sanitizeDisplayText(rel, Number.POSITIVE_INFINITY);

/** A wikilink to `rel`, or a markdown link when the path has characters a wikilink cannot hold. */
function linkTo(raw: string): string {
  const rel = plainPath(raw);
  const stem = rel.replace(/\.md$/i, "");
  const label = (stem.split("/").pop() ?? stem).replace(/[[\]|\r\n]/g, " ").slice(0, 120);
  return /[[\]|#^\\\r\n]/.test(stem)
    ? `[${label}](${encodeURI(rel).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)})`
    : `[[${stem}|${label}]]`;
}

/** May a reader holding no rule-scope see `rel` named in a generated file? The vault ACL is applied
 *  to the REAL path (a symlink alias of a read-denied folder is denied), and Excluded files are
 *  tested on the lexical name and the resolved one. */
function listable(env: WikiGenerateEnv, rel: string): boolean {
  if (!callerCanReadVaultPath(env.acl, SCOPELESS, env.root, rel) || env.exclusion.isExcluded(rel))
    return false;
  try {
    return !env.exclusion.isExcluded(resolveVaultPathChecked(env.root, rel).aclRel);
  } catch {
    return false;
  }
}

const isGeneratedLog = (rel: string): boolean => rel.endsWith(`/${WIKI_LOG_FILE}`);

interface Group {
  type: string;
  pages: string[];
}

function collectGroups(env: WikiGenerateEnv, folder: string): { groups: Group[]; cut: number } {
  const scope: ScanScope = { root: env.root, acl: env.acl, grantedScopes: SCOPELESS };
  const schemaPath = `${folder}/${WIKI_SCHEMA_FILE}`;
  const all = readableNotes(env.root, env.acl, SCOPELESS, folder)
    .filter(
      (p) =>
        !isGeneratedWikiPath(p, folder) &&
        p !== schemaPath &&
        pathInFolder(p, folder) &&
        listable(env, p),
    )
    .sort();
  const pages = all.slice(0, INDEX_MAX_PAGES);
  const byType = new Map<string, string[]>();
  for (const rel of pages) {
    let type = NO_TYPE;
    try {
      const raw = readNoteBounded(resolveVaultPath(env.root, rel), 64 * 1024).raw;
      const t = raw === null ? undefined : parseNoteLenient(raw).frontmatter?.[WIKI_TYPE_KEY];
      if (typeof t === "string" && t.trim() !== "")
        type = /^[\p{L}\p{N} _.-]{1,64}$/u.test(t.trim()) ? t.trim() : OTHER_TYPE;
    } catch {
      // An unreadable page is listed untyped: the index is a map, not a validator.
    }
    byType.set(type, [...(byType.get(type) ?? []), rel]);
  }
  let declared: string[] = [];
  try {
    declared = loadWikiSchema(scope, folder).schema?.types.map((t) => t.name) ?? [];
  } catch {
    // No readable SCHEMA.md: the types are listed alphabetically.
  }
  const rank = (t: string): number =>
    t === NO_TYPE ? 2 : t === OTHER_TYPE ? 1 : declared.includes(t) ? -1 : 0;
  const types = [...byType.keys()].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (declared.includes(a) ? declared.indexOf(a) - declared.indexOf(b) : a.localeCompare(b)),
  );
  return {
    groups: types.map((type) => ({ type, pages: byType.get(type) as string[] })),
    cut: all.length - pages.length,
  };
}

function renderIndex(env: WikiGenerateEnv, path: string, groups: Group[], cut: number): string {
  const lines = [
    frontmatterFor("index", { vaultId: env.vaultId, path }),
    NOTICE("the vault index"),
    "",
    "# Wiki index",
    "",
  ];
  if (groups.length === 0) lines.push("No pages yet.", "");
  for (const g of groups) {
    lines.push(`## ${g.type} (${g.pages.length})`, "");
    for (const p of g.pages) lines.push(`- ${linkTo(p)}`);
    lines.push("");
  }
  if (cut > 0) lines.push(`${cut} more page(s) are not listed (the index is capped).`, "");
  return lines.join("\n");
}

const field = (s: string | undefined, max: number): string =>
  s
    ?.replace(/[^\p{L}\p{N} ._:@+/-]/gu, "")
    .trim()
    .slice(0, max) || "-";

/** The log lines for provenance rows after `lastSeq`, and the last seq looked at. */
function projectRows(
  env: WikiGenerateEnv,
  folder: string,
  lastSeq: number,
): { lines: string[]; through: number; full: boolean } {
  let rows: Array<{ seq: number; body: string }> = [];
  try {
    rows = env.db
      .prepare(
        "SELECT seq, body FROM write_provenance WHERE vault_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(env.vaultId, lastSeq, LOG_ROWS_PER_PASS) as typeof rows;
  } catch {
    // No provenance table (provenance off, or a cache.db from before it): nothing to project.
  }
  const lines: string[] = [];
  for (const r of rows) {
    let b: {
      ts?: number;
      tool?: string;
      outcome?: string;
      paths?: Array<{ path: string; before: string; after: string }>;
      verified?: { principal?: string };
      unauthenticated?: { principal?: string };
      self_reported?: { model?: string };
    };
    try {
      b = JSON.parse(r.body);
    } catch {
      continue;
    }
    if (b.outcome === "pending" || typeof b.ts !== "number") continue;
    const when = new Date(b.ts).toISOString().replace(/\.\d{3}Z$/, "Z");
    const who = field(b.verified?.principal ?? b.unauthenticated?.principal, 64);
    const model = field(b.self_reported?.model, 64);
    const seen = new Set<string>();
    for (const e of b.paths ?? []) {
      let rel: string;
      try {
        rel = normalizeVaultPath(e.path);
      } catch {
        continue;
      }
      if (seen.has(rel) || e.before === e.after) continue;
      seen.add(rel);
      if (!pathInFolder(rel, folder) || isGeneratedWikiPath(rel, folder) || !listable(env, rel))
        continue;
      const op = e.before === "absent" ? "create" : e.after === "absent" ? "delete" : "update";
      const shown = plainPath(rel).replace(/\|/g, "?");
      lines.push(`${when} | ${op} | ${shown} | ${who} | ${model} | ${field(b.tool, 40)}#${r.seq}`);
    }
  }
  return { lines, through: rows.at(-1)?.seq ?? lastSeq, full: rows.length >= LOG_ROWS_PER_PASS };
}

const LOG_HEAD = `${NOTICE("the write provenance chain")}\n\n# Wiki log\n\nOne line per change to a page in this folder: time (UTC) | op | path | principal | model (as the client reported it) | tool#provenance seq. Reading this page needs the read:provenance scope.\n\n`;

// The cursor line. Parsed and replaced with the same pattern, tolerant of trailing blanks, so a
// line that no longer ends at the digits can neither restart the log from 0 nor go unreplaced.
const LAST_SEQ_LINE = /^last_seq:[ \t]*(\d+)[ \t]*$/m;

/** Build `log.md`: the previous text (ours, verified by the caller) plus the new lines. */
function renderLog(
  env: WikiGenerateEnv,
  folder: string,
  prev: string | null,
  forceCreate = false,
): string | null {
  const last = prev === null ? 0 : Number(LAST_SEQ_LINE.exec(prev)?.[1] ?? 0);
  const { lines, through, full } = projectRows(env, folder, last);
  // Rewrite only for new lines, or when a full pass of unrelated rows must be skipped over.
  if (lines.length === 0 && !full && !forceCreate) return null;
  const add = lines.map((l) => `${l}\n`).join("");
  if (prev === null)
    return `${frontmatterFor("log", { vaultId: env.vaultId, path: `${folder}/${WIKI_LOG_FILE}` }, `last_seq: ${through}\n`)}${LOG_HEAD}${add}`;
  return `${blankHash(prev)
    .replace(LAST_SEQ_LINE, () => `last_seq: ${through}`)
    .replace(/\n*$/, "\n")}${add}`;
}

/** One generated page through the guards and the atomic writer; records what it wrote or why not. */
function writeGenerated(
  env: WikiGenerateEnv,
  folder: string,
  rel: string,
  build: (prev: string | null, migratingLegacy: boolean) => string | null,
  out: WikiGenerateResult,
): undefined {
  const warn = (kind: GeneratedWarning["kind"], message: string): undefined => {
    out.warnings.push({ path: rel, kind, message });
    return undefined;
  };
  let snapshotId: number | null = null;
  try {
    // The full write check. The server holds no rule-scope, except the one the log's own implicit
    // rule asks for; a path an operator rule also gates behind another scope is therefore not ours.
    try {
      enforcePathAcl(
        env.acl,
        "write",
        rel,
        env.root,
        isGeneratedLog(rel) ? [WIKI_LOG_SCOPE] : SCOPELESS,
      );
    } catch (e) {
      if (e instanceof ObsidianTcError && (e.code === "acl_denied" || e.code === "read_only_mode"))
        return warn("denied", `${rel} was not generated: the vault ACL does not allow writing it`);
      throw e;
    }
    assertWikiPagePath(env.root, folder, rel);
    const abs = resolveVaultPath(env.root, rel);
    const ex = noteExists(abs);
    if (ex.exists && ex.type === "folder") return warn("failed", `${rel} is a folder`);
    const prev = ex.exists ? readNote(abs).raw : null;
    let migratingLegacy = false;
    if (prev !== null) {
      const state = inspectGenerated(prev, env.sealKey, { vaultId: env.vaultId, path: rel });
      migratingLegacy = state === "legacy";
      if (state !== "ours" && state !== "legacy")
        return warn(
          state,
          state === "edited"
            ? `${rel} was edited by hand, so it is no longer regenerated. Delete it to have it rebuilt (restore_note keeps a copy), or move your edit elsewhere`
            : `${rel} exists and was not generated by obsidian-tc, so it is left alone. Rename it to have the generated page written`,
        );
    }
    // A valid legacy SHA seal authorises replacement only, never reuse: rebuilding from null keeps
    // a forged preamble or last_seq from becoming input to the new keyed file.
    const draft = build(migratingLegacy ? null : prev, migratingLegacy);
    if (draft === null) return;
    // The memory-defense scan runs before the seal, so a redaction is part of what is sealed.
    const guarded = enforceMemoryDefenseOnNoteWrite(env.memoryDefense, rel, draft, {
      ...(env.metrics ? { metrics: env.metrics } : {}),
    }).content;
    const content = seal(guarded, env.sealKey, { vaultId: env.vaultId, path: rel });
    if (content === prev) return;
    if (prev !== null)
      snapshotId = captureSnapshot(
        env.db,
        env.snapshots,
        env.vaultId,
        rel,
        prev,
        "wiki_generated",
        env.now,
        false,
      );
    // One-note write batch: the bytes are hashed again right before the rename and compared with
    // `prev`, so an edit made while this page was being rebuilt aborts instead of being replaced.
    applyWriteBatch([{ abs, rel, content, prevRaw: prev }]);
    if (env.snapshots?.enabled && prev !== null)
      pruneSnapshots(env.db, env.vaultId, rel, env.snapshots.retention);
    out.written.push(rel);
  } catch (e) {
    try {
      if (snapshotId !== null) discardSnapshots(env.db, [snapshotId]);
    } catch {
      // A snapshot row that cannot be dropped is harmless: this still reports the real failure.
    }
    if (e instanceof ObsidianTcError && e.code === "concurrent_modification")
      warn(
        "edited",
        `${rel} was edited while it was being regenerated, so it was left as it is. Delete it to have it rebuilt (restore_note keeps a copy), or move your edit elsewhere`,
      );
    else warn("failed", `${rel} was not generated: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Regenerate `index.md` and `log.md` in the vault's wiki folder. Never throws. */
export function regenerateWikiPages(env: WikiGenerateEnv): WikiGenerateResult {
  const out: WikiGenerateResult = { written: [], warnings: [] };
  const folder = env.wikiFolder;
  if (!folder || env.acl?.readOnly) return out;
  writeGenerated(
    env,
    folder,
    `${folder}/${WIKI_INDEX_FILE}`,
    () => {
      const { groups, cut } = collectGroups(env, folder);
      return renderIndex(env, `${folder}/${WIKI_INDEX_FILE}`, groups, cut);
    },
    out,
  );
  writeGenerated(
    env,
    folder,
    `${folder}/${WIKI_LOG_FILE}`,
    (prev, migratingLegacy) => renderLog(env, folder, prev, migratingLegacy),
    out,
  );
  return out;
}
