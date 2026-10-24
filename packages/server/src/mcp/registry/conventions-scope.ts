// Dispatch's side of the folder conventions check, kept out of dispatch.ts (which sits at biome's line cap).
// A tool whose output schema declares `conventions` gets its written notes checked against the SCHEMA.md
// rules that apply to them. `begin` (a mutating call, before the handler) stats the notes the call names;
// `annotate` (after the handler succeeded) re-stats them and judges only the notes that changed, plus any
// the handler reported through `ctx.noteWritten`. Advisory and fail-open: a check that throws is reported
// through onInternalError and the write stands without a `conventions` key.
import { statSync } from "node:fs";
import { basename, isAbsolute, relative, sep } from "node:path";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { blockingDelta, checkNote, judges } from "../../conventions/check";
import {
  type ConventionsScope,
  evictConventionsLayer,
  resolveConventions,
} from "../../conventions/resolve";
import { CONVENTIONS_KEY, NOTE_MAX_BYTES } from "../../conventions/schema";
import { WIKI_SCHEMA_FILE } from "../../tools/m7/knowledge/wiki-schema";
import { capWarningsOut, MAX_SCAN_WARNINGS } from "../../tools/scan-warnings";
import { createSliceYielder } from "../../util/scan-steps";
import { CROSS_NOTE_REWRITE_TOOLS } from "../../vault/acl-audit";
import { enforcePathAcl } from "../../vault/acl-path";
import { callerMayReadNote } from "../../vault/cas";
import { parseNoteLenient } from "../../vault/frontmatter";
import { readNoteBounded } from "../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath } from "../../vault/paths";
import type { VaultRegistry } from "../../vault/registry";
import { type NoteWriteGate, withWriteGate } from "../../vault/write-gate";
import { vaultArgOf } from "./input-binding";
import { isOverflow } from "./result-governance";
import type { CallerContext, ConventionsSink, RegistryOptions, ToolDefinition } from "./types";

/** Notes a single call may name: the rest are not stat'd, so a bulk call cannot make begin unbounded. */
const MAX_NAMED_NOTES = 500;

export interface ConventionsDispatch {
  begin(def: ToolDefinition, input: unknown, ctx: CallerContext): Promise<void>;
  /** Runs a mutating handler with the write gate installed (see conventions/write-gate.ts). A call that
   *  took no pending check runs `fn` as is. */
  run<T>(def: ToolDefinition, ctx: CallerContext, fn: () => T): T;
  annotate(def: ToolDefinition, out: unknown, ctx: CallerContext): Promise<void>;
  /** A mutating call that failed before it settled: drop the pending check and the noteWritten hook. */
  abandon(ctx: CallerContext): void;
}

interface PendingCheck {
  def: ToolDefinition;
  vault: string;
  root: string;
  state: object;
  noted: Set<string>;
}

/** The gate's verdict is a convention refusal only when the error carries this code. */
const isConventionBlocked = (e: unknown): boolean =>
  (e as { code?: unknown } | null)?.code === "convention_blocked";

/** True when the tool's advertised output schema has a `conventions` key: only those pay for the check. */
function declaresConventions(def: ToolDefinition): boolean {
  const shape = (def.outputSchema as { shape?: Record<string, unknown> } | undefined)?.shape;
  return shape !== undefined && Object.hasOwn(shape, CONVENTIONS_KEY);
}

export function conventionsScope(
  sink: ConventionsSink | undefined,
  rootResolver: RegistryOptions["rootResolver"],
  onInternalError: RegistryOptions["onInternalError"],
  maxResponseBytes: number,
): ConventionsDispatch {
  let pending: PendingCheck | undefined;
  return {
    async begin(def, input, ctx) {
      pending = undefined;
      if (sink === undefined || !declaresConventions(def)) return;
      const vault = vaultArgOf(def, input) ?? ctx.vaultId;
      const root = rootResolver?.(vault);
      if (root === undefined) return;
      const noted = new Set<string>();
      ctx.noteWritten = (rel) => {
        noted.add(rel);
      };
      try {
        pending = { def, vault, root, noted, state: await sink.begin(def, input, ctx, root) };
      } catch (e) {
        report(onInternalError, `conventions:${def.name}`, vault, e);
      }
    },
    async annotate(def, out, ctx) {
      const p = pending;
      pending = undefined;
      delete ctx.noteWritten;
      if (p === undefined || p.def !== def || sink === undefined) return;
      if (typeof out !== "object" || out === null) return;
      try {
        const field = await sink.check(p.state, out, ctx, p.root, p.noted);
        // Advisory: a field that would push the committed response over the byte budget is dropped, not raised.
        if (field !== undefined && !isOverflow(sizeWith(out, field), maxResponseBytes))
          (out as { conventions?: object }).conventions = field;
      } catch (e) {
        report(onInternalError, `conventions:${def.name}`, p.vault, e);
      }
    },
    run(def, ctx, fn) {
      const p = pending;
      if (sink?.gate === undefined || p === undefined || p.def !== def) return fn();
      let gate: NoteWriteGate;
      try {
        gate = sink.gate(p.state, ctx, p.root);
      } catch (e) {
        report(onInternalError, `conventions:${def.name}`, p.vault, e);
        return fn();
      }
      // Fail-open: a refusal stops the write; any other fault is reported and the write goes ahead.
      const guarded: NoteWriteGate = {
        check(abs, text) {
          try {
            gate.check(abs, text);
          } catch (e) {
            if (isConventionBlocked(e)) throw e;
            report(onInternalError, `conventions:${def.name}`, p.vault, e);
          }
        },
      };
      return withWriteGate(guarded, fn);
    },
    abandon(ctx) {
      pending = undefined;
      delete ctx.noteWritten;
    },
  };
}

/** The serialized size of the response were `field` added: what dispatch's overflow check will measure. */
function sizeWith(out: object, field: object): number {
  return Buffer.byteLength(JSON.stringify({ ...out, [CONVENTIONS_KEY]: field }), "utf8");
}

/** Reports an internal fault; a reporter that itself throws must not turn a committed write into an error. */
function report(
  onInternalError: RegistryOptions["onInternalError"],
  name: string,
  vault: string,
  e: unknown,
): void {
  try {
    onInternalError?.(name, vault, e);
  } catch {
    // best-effort: the write stands
  }
}

/** The write-op `.md` paths a call names that the caller may write, in pathAcl order, capped. */
function namedWriteNotes(
  def: ToolDefinition,
  input: unknown,
  ctx: CallerContext,
  root: string,
): string[] {
  if (!def.pathAcl) return [];
  let named: ReturnType<NonNullable<ToolDefinition["pathAcl"]>>;
  try {
    named = def.pathAcl(input, { root });
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const { op, path } of named) {
    if (op !== "write" || out.size >= MAX_NAMED_NOTES) continue;
    // Normalised as the handler normalises its own path, so the stat keys and the result's path agree.
    let rel: string;
    try {
      rel = normalizeVaultPath(path);
      if (!rel.endsWith(".md")) continue;
      enforcePathAcl(ctx.acl, "write", rel, root, ctx.grantedScopes);
    } catch {
      continue;
    }
    out.add(rel);
  }
  return [...out];
}

/** A note's identity on disk: changes on any rewrite, so an untouched pre-existing note keeps its key. */
function stampOf(root: string, rel: string): string | null {
  try {
    const s = statSync(resolveVaultPath(root, rel), { bigint: true });
    return s.isFile() ? `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` : null;
  } catch {
    return null;
  }
}

/** The hash of `rel` the write itself reported under `key`, when the result names that note. */
function reportedHash(
  result: unknown,
  rel: string,
  key: "content_hash" | "prev_hash",
): string | undefined {
  const r = result as { path?: unknown } & Record<string, unknown>;
  return r.path === rel && typeof r[key] === "string" ? (r[key] as string) : undefined;
}

/** True when the write reported the note's bytes before it as the bytes after it: a rewrite that changed nothing. */
function rewroteSameBytes(result: unknown, rel: string): boolean {
  const before = reportedHash(result, rel, "prev_hash");
  return before !== undefined && before === reportedHash(result, rel, "content_hash");
}

/** The note's frontmatter (null when it has none) as the caller may see it; undefined to skip the note. */
function frontmatterOf(
  ctx: CallerContext,
  root: string,
  rel: string,
  result: unknown,
): ReturnType<typeof parseNoteLenient>["frontmatter"] | undefined {
  if (!callerMayReadNote(ctx, root, rel)) return undefined;
  try {
    const { raw } = readNoteBounded(resolveVaultPath(root, rel), NOTE_MAX_BYTES);
    if (raw === null) return undefined;
    const hash = reportedHash(result, rel, "content_hash");
    if (hash !== undefined && contentHash(raw) !== hash) return undefined; // changed again since the write
    return parseNoteLenient(raw, rel).frontmatter;
  } catch {
    return undefined;
  }
}

/** The sink dispatch wires: stats at begin, checks the changed notes at annotate. Pure over the disk. */
/** The vault's wiki and raw folder names, read at check time so a vault added at runtime is covered. */
function foldersOf(
  registry: Pick<VaultRegistry, "resolve">,
  vaultId: string,
): Pick<ConventionsScope, "wikiFolders" | "rawFolders"> {
  try {
    const v = registry.resolve(vaultId);
    return { wikiFolders: v.wikiFolders, rawFolders: v.rawFolders };
  } catch {
    return {};
  }
}

/** One mutating call's check state: the named write notes (their stat at begin), the tool, and the
 *  per-path rules resolved once, shared by the write gate and the post-write annotate. */
interface CheckState {
  stamps: ReadonlyMap<string, string | null>;
  tool: string;
  effs: Map<string, ReturnType<typeof resolveConventions>>;
}

/** The vault-relative posix path of `abs` under `root`, or undefined when it is outside the root. */
function vaultRelOf(root: string, abs: string): string | undefined {
  const r = relative(root, abs);
  if (r === "" || r.startsWith("..") || isAbsolute(r)) return undefined;
  try {
    return normalizeVaultPath(r.split(sep).join("/"));
  } catch {
    return undefined;
  }
}

/** Rules for `rel` as the caller sees them, resolved once per call and path. */
function effOf(
  st: CheckState,
  registry: Pick<VaultRegistry, "resolve">,
  ctx: CallerContext,
  root: string,
  rel: string,
): ReturnType<typeof resolveConventions> {
  const memo = st.effs.get(rel);
  if (memo !== undefined) return memo;
  const eff = resolveConventions(
    {
      vaultId: ctx.vaultId,
      root,
      acl: ctx.acl,
      grantedScopes: ctx.grantedScopes,
      ...foldersOf(registry, ctx.vaultId),
    },
    rel,
  );
  st.effs.set(rel, eff);
  return eff;
}

/** True when some rule in the effective set is levelled `block`. */
function hasBlockRule(eff: ReturnType<typeof resolveConventions>): boolean {
  const blocks = (m: Record<string, { value: string }>): boolean =>
    Object.values(m).some((l) => l.value === "block");
  return blocks(eff.severity) || Object.values(eff.types).some((t) => blocks(t.severity));
}

/** The note's frontmatter before the write, as the caller may see it: undefined when there is no such
 *  note or the caller may not read it (judged as new, so nothing of it leaks); null when its YAML is broken. */
function beforeFrontmatter(
  ctx: CallerContext,
  root: string,
  rel: string,
): ReturnType<typeof parseNoteLenient>["frontmatter"] | undefined {
  if (!callerMayReadNote(ctx, root, rel)) return undefined;
  try {
    const { raw } = readNoteBounded(resolveVaultPath(root, rel), NOTE_MAX_BYTES);
    return raw === null ? undefined : parseNoteLenient(raw, rel).frontmatter;
  } catch {
    return undefined;
  }
}

/** Throws the convention_blocked refusal when the write at `abs` would add a blocking violation. */
function judgeWrite(
  st: CheckState,
  registry: Pick<VaultRegistry, "resolve">,
  ctx: CallerContext,
  root: string,
  abs: string,
  text: string,
): void {
  const rel = vaultRelOf(root, abs);
  if (rel === undefined) return;
  // Warn-only (design decision 7): a restore, and a backlink rewrite of a note the call did not name.
  if (st.tool === "restore_note") return;
  if (CROSS_NOTE_REWRITE_TOOLS.has(st.tool) && !st.stamps.has(rel)) return;
  const eff = effOf(st, registry, ctx, root, rel);
  if (!judges(eff, rel) || !hasBlockRule(eff)) return;
  const delta = blockingDelta(
    eff,
    rel,
    beforeFrontmatter(ctx, root, rel),
    parseNoteLenient(text, rel).frontmatter,
  );
  if (delta.length === 0) return;
  throw err.conventionBlocked(
    `this write would add ${delta.length} folder convention violation(s) marked block; nothing was written`,
    {
      path: rel,
      violations: delta.slice(0, MAX_SCAN_WARNINGS),
      violations_omitted: Math.max(0, delta.length - MAX_SCAN_WARNINGS),
    },
  );
}

export function conventionsChecker(registry: Pick<VaultRegistry, "resolve">): ConventionsSink {
  return {
    async begin(def, input, ctx, root) {
      const stamps = new Map<string, string | null>();
      for (const rel of namedWriteNotes(def, input, ctx, root)) stamps.set(rel, stampOf(root, rel));
      const state: CheckState = { stamps, tool: def.name, effs: new Map() };
      return state;
    },
    gate(pending, ctx, root) {
      const st = pending as CheckState;
      return { check: (abs, text) => judgeWrite(st, registry, ctx, root, abs, text) };
    },
    async check(pending, result, ctx, root, noted) {
      const st = pending as CheckState;
      const { stamps } = st;
      if (ctx.signal?.aborted) return undefined;
      const candidates = new Set<string>();
      for (const [rel, before] of stamps) if (stampOf(root, rel) !== before) candidates.add(rel);
      for (const rel of noted) candidates.add(rel);
      // A stat that moved on a rewrite of identical bytes is not a change to the note.
      for (const rel of candidates) if (rewroteSameBytes(result, rel)) candidates.delete(rel);
      // A SCHEMA.md this call wrote is re-read before any note in its folder is judged against it.
      for (const rel of candidates)
        if (basename(rel) === WIKI_SCHEMA_FILE) {
          evictConventionsLayer(ctx.vaultId, rel);
          st.effs.clear();
        }

      const yieldSlice = createSliceYielder(ctx.signal);
      const warnings: ReturnType<typeof checkNote> = [];
      const files = new Map<string, { path: string; message: string }>();
      let filesOmitted = 0;
      for (const rel of candidates) {
        await yieldSlice();
        if (ctx.signal?.aborted) return undefined;
        const fm = frontmatterOf(ctx, root, rel, result);
        if (fm === undefined) continue;
        const eff = effOf(st, registry, ctx, root, rel);
        warnings.push(...checkNote(eff, rel, fm));
        for (const f of eff.fileWarnings) files.set(`${f.path}\0${f.message}`, f);
        filesOmitted = Math.max(filesOmitted, eff.fileWarningsOmitted);
      }
      // A layer's file warnings are reported only for a SCHEMA.md this call wrote, or for a layer that a
      // note this call judged broke: an unrelated SCHEMA.md problem does not make a clean write noisy.
      const wrote = new Set([...candidates].filter((rel) => basename(rel) === WIKI_SCHEMA_FILE));
      const broke = new Set(warnings.map((w) => w.source));
      const fileList = [...files.values()].filter((f) => wrote.has(f.path) || broke.has(f.path));
      if (warnings.length === 0 && fileList.length === 0) return undefined;
      const fileOverflow = Math.max(0, fileList.length - MAX_SCAN_WARNINGS);
      return {
        ...capWarningsOut(warnings),
        ...(fileList.length > 0 ? { file_warnings: fileList.slice(0, MAX_SCAN_WARNINGS) } : {}),
        ...(fileList.length > 0 && filesOmitted + fileOverflow > 0
          ? { file_warnings_omitted: filesOmitted + fileOverflow }
          : {}),
      };
    },
  };
}
