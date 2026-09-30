// get / update / append / patch / delete _active_file — the same note operations the path-addressed
// tools do, aimed at whichever note is open in the live Obsidian session. Two rules keep this from
// being a second implementation of note I/O:
//
//   1. WHICH note is decided once per call, by `resolveTarget` (mcp/registry/types.ts), through the
//      companion's GET /files/active. Dispatch merges the resolved path into the input BEFORE the
//      folder ACL, HITL and idempotency stages run and folds it into the args hash, so all of them
//      act on the note that is actually hit, and a confirmation raised while note A was open cannot
//      be redeemed after focus moves to note B. No active file, no live session or an unusable
//      bridge is a typed error with a hint, never a fallback to some default path.
//   2. WHAT happens to it is delegated to the registered read_note / write_note / append_note /
//      patch_note / delete_note handlers with the resolved path, so scopes, the per-vault ACL,
//      memoryDefense, snapshots, the write_note overwrite confirmation, compare-and-swap and
//      reindexing apply identically. The input schemas are derived from those tools' own.
//
// Only markdown notes are mutated: a canvas, PDF or image that happens to be active is refused for
// update/append/patch/delete (the byte-level note writers would corrupt it), and get_active_file
// answers with metadata alone for it.
import { err, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { CallerContext, ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { noteExists, statNote } from "../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import {
  AppendInput,
  AppendNoteOutput,
  DeleteInput,
  DeleteNoteOutput,
  NoteStatOut,
  PatchAnchor,
  PatchInputShape,
  PatchNoteOutput,
  ReadNoteOutput,
  refinePatchInput,
  WriteInput,
  WriteNoteOutput,
} from "../m1/notes/schemas";
import {
  bridgeTimeouts,
  companionUnreachable,
  type M4Deps,
  openCompanionBridge,
  withDegradeHint,
} from "./shared";

/** Looks up a registered tool definition by name (the note tools are registered by M1). */
export type DelegateLookup = (name: string) => ToolDefinition | undefined;

const COMPANION_HINT =
  "Start Obsidian with the obsidian-tc companion plugin and Local REST API enabled for this vault, open a note, then retry.";
const COMPANION_TOO_OLD_HINT =
  "The companion plugin is too old to report the active file; update the companion plugin inside Obsidian.";
const NO_ACTIVE_HINT =
  "Open a note in the Obsidian window for this vault (a note the caller may access), then retry; or use the path-addressed tools.";
const NOT_MARKDOWN_HINT =
  "Only markdown notes can be changed through the active-file tools; get_active_file reports the active file's path and type, and the structured-document tools handle canvases and Excalidraw drawings.";

const ActiveFileReport = z.object({
  path: z.string().nullable(),
  extension: z.string().nullable().optional(),
});

/** The resolved target every tool here binds: the vault-relative path of the active file. */
interface ActiveTarget {
  path: string;
}

const isMarkdown = (path: string): boolean => path.toLowerCase().endsWith(".md");

/** Ask the live Obsidian session which file is active. Throws a typed, hinted error for every way
 *  that can fail; never returns a guess. */
async function resolveActiveFile(deps: M4Deps, vaultInput: string): Promise<ActiveTarget> {
  const v = deps.vaultRegistry.resolve(vaultInput);
  let raw: unknown;
  try {
    const { client } = openCompanionBridge(deps, v.id);
    raw = await client.request({
      method: "GET",
      path: "/files/active",
      plugin: "obsidian-tc-companion",
      timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
    });
  } catch (e) {
    // plugin_incompatible and a bridge-side refusal are answers; only "no working companion path"
    // gets the start-Obsidian hint, and a 404 means the route itself is missing (an old companion).
    if (!companionUnreachable(e)) throw e;
    throw withDegradeHint(
      e,
      e.details?.http_status === 404 ? COMPANION_TOO_OLD_HINT : COMPANION_HINT,
    );
  }
  const report = ActiveFileReport.safeParse(raw);
  if (!report.success)
    throw err.pluginUnreachable("companion returned an unexpected active-file payload", {
      plugin: "obsidian-tc-companion",
      hint: COMPANION_TOO_OLD_HINT,
    });
  if (report.data.path === null)
    throw err.noteNotFound("no note is open in Obsidian", {
      vault: v.id,
      reason: "no_active_file",
      hint: NO_ACTIVE_HINT,
    });
  // The path comes from another process: hold it to the same shape every caller-supplied path meets.
  const path = VaultPath.safeParse(report.data.path);
  if (!path.success)
    throw err.invalidInput("the companion reported an unusable active file path", {
      vault: v.id,
      reason: "unusable_active_path",
      hint: COMPANION_TOO_OLD_HINT,
    });
  return { path: path.data };
}

/** resolveTarget for the mutating tools: also refuses a non-markdown active file, before any gate
 *  that would ask a human to confirm something the tool cannot do. The message names neither the
 *  path nor the type, because the folder ACL has not yet had its say about this note. */
const resolveMarkdownTarget = async (
  deps: M4Deps,
  input: { vault: string },
): Promise<ActiveTarget> => {
  const target = await resolveActiveFile(deps, input.vault);
  if (!isMarkdown(target.path))
    throw err.invalidInput("the active file is not a markdown note", {
      reason: "not_markdown",
      hint: NOT_MARKDOWN_HINT,
    });
  return target;
};

function delegateTo(lookup: DelegateLookup, name: string): ToolDefinition {
  const def = lookup(name);
  if (!def) throw err.internalError(`active-file tools need ${name} to be registered`);
  return def;
}

/** Run `name`'s own handler on `args` (validated and defaulted by that tool's schema, exactly as
 *  dispatch would). Result shape is the delegate's. */
async function delegate(
  lookup: DelegateLookup,
  name: string,
  args: Record<string, unknown>,
  ctx: CallerContext,
): Promise<unknown> {
  const def = delegateTo(lookup, name);
  return def.handler(def.inputSchema.parse(args), ctx);
}

const { path: _path, ...ActivePatchShape } = PatchInputShape;
const PatchActiveInput = z.object(ActivePatchShape).strict().superRefine(refinePatchInput);

const ReadActiveInput = z.object({ vault: VaultId, anchor: PatchAnchor.optional() }).strict();

/** get_active_file's result: read_note's fields for a markdown note; metadata alone otherwise. */
const GetActiveOutput = ReadNoteOutput.partial().extend({
  vault: z.string(),
  path: z.string(),
  extension: z.string(),
  is_markdown: z.boolean(),
  stat: NoteStatOut.optional(),
});

const extensionOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

export function buildActiveFileTools(deps: M4Deps, lookup: DelegateLookup): ToolDefinition[] {
  return [
    defineTool({
      name: "get_active_file",
      domain: "workspace",
      vaultArg: "vault",
      description:
        "Read the note currently open in the live Obsidian session (same result as read_note, including the optional anchor section). Resolves the active file through the companion plugin, then reads it under the normal read scope and folder ACL. When the active file is not markdown (a canvas, PDF or image) it returns its path, extension and stat only. Errors, never guesses: note_not_found with reason no_active_file when nothing is open; plugin_unreachable / requires_live_obsidian when there is no live session.",
      inputSchema: ReadActiveInput,
      outputSchema: GetActiveOutput,
      requiredScopes: ["read:notes"],
      tags: ["plugin-bridge"],
      resolveTarget: (input): Promise<ActiveTarget> => resolveActiveFile(deps, input.vault),
      pathAcl: (input) => [{ op: "read", path: input.path }],
      handler: async (input, ctx) => {
        const extension = extensionOf(input.path);
        if (isMarkdown(input.path)) {
          const note = (await delegate(
            lookup,
            "read_note",
            { vault: input.vault, path: input.path, anchor: input.anchor },
            ctx,
          )) as z.infer<typeof ReadNoteOutput>;
          return { ...note, extension, is_markdown: true };
        }
        // Metadata only: no delegate to lean on, so the same guards read_note runs.
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "read", rel, v.root, ctx.grantedScopes);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("active file not found on disk", { vault: v.id, path: rel });
        return { vault: v.id, path: rel, extension, is_markdown: false, stat: statNote(abs) };
      },
    }),

    defineTool({
      name: "update_active_file",
      domain: "workspace",
      vaultArg: "vault",
      acceptsIdempotencyKey: true,
      description:
        "Replace the whole content of the note currently open in the live Obsidian session (write_note in overwrite mode, aimed at the active note). Overwriting a non-empty note requires human confirmation bound to the resolved note: a confirmation raised while one note was active cannot be redeemed once another is. Same prev_hash compare-and-swap, snapshot, memoryDefense and provenance rules as write_note; get_active_file returns the content_hash to pass as prev_hash. Refuses a non-markdown active file.",
      inputSchema: WriteInput.omit({ path: true, mode: true }),
      outputSchema: WriteNoteOutput,
      requiredScopes: ["write:notes"],
      tags: ["plugin-bridge"],
      conditionallyDestructive: true,
      resolveTarget: (input): Promise<ActiveTarget> => resolveMarkdownTarget(deps, input),
      pathAcl: (input) => [{ op: "write", path: input.path }],
      handler: (input, ctx) =>
        delegate(lookup, "write_note", { ...input, mode: "overwrite" }, ctx) as Promise<
          z.infer<typeof WriteNoteOutput>
        >,
    }),

    defineTool({
      name: "append_active_file",
      domain: "workspace",
      vaultArg: "vault",
      acceptsIdempotencyKey: true,
      description:
        "Append content to the note currently open in the live Obsidian session (append_note, aimed at the active note), preserving existing bytes. Same prev_hash compare-and-swap, snapshot, memoryDefense and provenance rules as append_note. Refuses a non-markdown active file.",
      inputSchema: AppendInput.omit({ path: true, create_if_missing: true }),
      outputSchema: AppendNoteOutput,
      requiredScopes: ["write:notes"],
      tags: ["plugin-bridge"],
      resolveTarget: (input): Promise<ActiveTarget> => resolveMarkdownTarget(deps, input),
      pathAcl: (input) => [{ op: "write", path: input.path }],
      handler: (input, ctx) =>
        delegate(lookup, "append_note", { ...input, create_if_missing: false }, ctx) as Promise<
          z.infer<typeof AppendNoteOutput>
        >,
    }),

    defineTool({
      name: "patch_active_file",
      domain: "workspace",
      vaultArg: "vault",
      description:
        "Patch a section of the note currently open in the live Obsidian session (patch_note, aimed at the active note): append, prepend, replace or replace_text under a heading, block reference or the frontmatter preamble. Same anchors, prev_hash compare-and-swap, confirm_replace guard, snapshot and memoryDefense rules as patch_note. Refuses a non-markdown active file.",
      inputSchema: PatchActiveInput,
      outputSchema: PatchNoteOutput,
      requiredScopes: ["write:notes"],
      tags: ["plugin-bridge"],
      resolveTarget: (input): Promise<ActiveTarget> => resolveMarkdownTarget(deps, input),
      pathAcl: (input) => [{ op: "write", path: input.path }],
      handler: (input, ctx) =>
        delegate(lookup, "patch_note", { ...input }, ctx) as Promise<
          z.infer<typeof PatchNoteOutput>
        >,
    }),

    defineTool({
      name: "delete_active_file",
      domain: "workspace",
      vaultArg: "vault",
      description:
        "Delete the note currently open in the live Obsidian session (delete_note, aimed at the active note): to the vault's .trash mirror, or permanently. Destructive: requires human confirmation bound to the resolved note, so a confirmation raised while one note was active cannot be redeemed once another is. restore_note reads its undo from a snapshot when snapshots are enabled. Refuses a non-markdown active file.",
      inputSchema: DeleteInput.omit({ path: true }),
      outputSchema: DeleteNoteOutput,
      requiredScopes: ["delete:notes"],
      tags: ["plugin-bridge"],
      destructive: true,
      resolveTarget: (input): Promise<ActiveTarget> => resolveMarkdownTarget(deps, input),
      pathAcl: (input) => [{ op: "delete", path: input.path }],
      handler: (input, ctx) =>
        delegate(lookup, "delete_note", { ...input }, ctx) as Promise<
          z.infer<typeof DeleteNoteOutput>
        >,
    }),
  ];
}
