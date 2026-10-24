// Dispatch's side of the folder conventions check, kept out of dispatch.ts (which sits at biome's line cap).
// A tool whose output schema declares `conventions` gets its written notes checked against the SCHEMA.md
// rules that apply to them. `begin` (a mutating call, before the handler) stats the notes the call names;
// `annotate` (after the handler succeeded) re-stats them and judges only the notes that changed, plus any
// the handler reported through `ctx.noteWritten`. Advisory and fail-open: a check that throws is reported
// through onInternalError and the write stands without a `conventions` key.
import { statSync } from "node:fs";
import { basename } from "node:path";
import { checkNote } from "../../conventions/check";
import {
  type ConventionsScope,
  evictConventionsLayer,
  resolveConventions,
} from "../../conventions/resolve";
import { CONVENTIONS_KEY } from "../../conventions/schema";
import { WIKI_SCHEMA_FILE } from "../../tools/m7/knowledge/wiki-schema";
import { capWarningsOut, MAX_SCAN_WARNINGS } from "../../tools/scan-warnings";
import { createSliceYielder } from "../../util/scan-steps";
import { enforcePathAcl } from "../../vault/acl-path";
import { callerMayReadNote } from "../../vault/cas";
import { parseNoteLenient } from "../../vault/frontmatter";
import { readNoteBounded } from "../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath } from "../../vault/paths";
import type { VaultRegistry } from "../../vault/registry";
import { vaultArgOf } from "./input-binding";
import { isOverflow } from "./result-governance";
import type { CallerContext, ConventionsSink, RegistryOptions, ToolDefinition } from "./types";

/** Notes a single call may name: the rest are not stat'd, so a bulk call cannot make begin unbounded. */
const MAX_NAMED_NOTES = 500;
/** A note larger than this is not parsed for conventions (the same bound the layer reader uses). */
const NOTE_MAX_BYTES = 1024 * 1024;

export interface ConventionsDispatch {
  begin(def: ToolDefinition, input: unknown, ctx: CallerContext): Promise<void>;
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

export function conventionsChecker(registry: Pick<VaultRegistry, "resolve">): ConventionsSink {
  return {
    async begin(def, input, ctx, root) {
      const stamps = new Map<string, string | null>();
      for (const rel of namedWriteNotes(def, input, ctx, root)) stamps.set(rel, stampOf(root, rel));
      return { stamps };
    },
    async check(pending, result, ctx, root, noted) {
      const { stamps } = pending as { stamps: ReadonlyMap<string, string | null> };
      if (ctx.signal?.aborted) return undefined;
      const candidates = new Set<string>();
      for (const [rel, before] of stamps) if (stampOf(root, rel) !== before) candidates.add(rel);
      for (const rel of noted) candidates.add(rel);
      // A stat that moved on a rewrite of identical bytes is not a change to the note.
      for (const rel of candidates) if (rewroteSameBytes(result, rel)) candidates.delete(rel);
      // A SCHEMA.md this call wrote is re-read before any note in its folder is judged against it.
      for (const rel of candidates)
        if (basename(rel) === WIKI_SCHEMA_FILE) evictConventionsLayer(ctx.vaultId, rel);

      const yieldSlice = createSliceYielder(ctx.signal);
      const warnings: ReturnType<typeof checkNote> = [];
      const files = new Map<string, { path: string; message: string }>();
      let filesOmitted = 0;
      const folders = foldersOf(registry, ctx.vaultId);
      for (const rel of candidates) {
        await yieldSlice();
        if (ctx.signal?.aborted) return undefined;
        const fm = frontmatterOf(ctx, root, rel, result);
        if (fm === undefined) continue;
        const eff = resolveConventions(
          {
            vaultId: ctx.vaultId,
            root,
            acl: ctx.acl,
            grantedScopes: ctx.grantedScopes,
            ...folders,
          },
          rel,
        );
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
