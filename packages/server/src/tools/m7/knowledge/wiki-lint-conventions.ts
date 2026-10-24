// lint_wiki's SCHEMA.md conventions scan. Every note the caller may read is checked against the rules
// of its folder chain (resolved once per folder), and every layer that carries file warnings is reported
// once. The scan returns plain proposals; wiki-lint.ts is their only caller, so this module never imports
// it.
import { checkNote, judges } from "../../../conventions/check";
import { type ConventionsScope, resolveConventions } from "../../../conventions/resolve";
import type { ConventionWarning, EffectiveConventions } from "../../../conventions/schema";
import type { ScanSteps } from "../../../util/scan-steps";
import { parseNoteLenient } from "../../../vault/frontmatter";
import { readNoteBounded } from "../../../vault/notes-io";
import { resolveVaultPath } from "../../../vault/paths";
import { capWarningsOut, MAX_SCAN_WARNINGS } from "../../scan-warnings";
import { readableNotesSteps } from "../../wiki-scan";

/** A note larger than this is not parsed for conventions (the bound the write check uses too). */
const NOTE_MAX_BYTES = 1024 * 1024;

/** Structurally a `Proposal` of wiki-lint.ts. */
export interface ConventionProposal {
  kind: "conventions" | "conventions_file";
  subject: string;
  detail: string;
  suggested_action: string;
  tool: string;
  tool_args?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
}

export interface ConventionsScan {
  notes: ConventionProposal[];
  files: ConventionProposal[];
}

/** The one fix that needs no invented value: a tag to remove, or a scalar with a single allowed value. */
function fixOf(
  vault: string,
  path: string,
  w: ConventionWarning,
): { tool: string; tool_args: Record<string, unknown> } | undefined {
  if (w.code !== "value_not_allowed" || w.property === undefined) return undefined;
  if (w.values?.length !== 1) return undefined;
  const value = w.values[0] as string;
  if (w.property === "tags" || w.property === "tag")
    return {
      tool: "remove_tag",
      tool_args: { vault, path, tag: value, location: "frontmatter" },
    };
  // An alias list is not a scalar: setting it to one value would drop the others.
  if (w.property === "aliases" || w.property === "alias") return undefined;
  if (w.allowed?.length !== 1) return undefined;
  return {
    tool: "update_frontmatter",
    tool_args: { vault, path, operation: "set", key: w.property, value: w.allowed[0] },
  };
}

function noteProposal(
  vault: string,
  path: string,
  warnings: ConventionWarning[],
): ConventionProposal {
  const { warnings: kept = [], warnings_omitted } = capWarningsOut(warnings);
  // tool_args only when ONE call fixes the whole proposal: a single warning with an unambiguous fix.
  const fix = warnings.length === 1 && warnings[0] ? fixOf(vault, path, warnings[0]) : undefined;
  return {
    kind: "conventions",
    subject: path,
    detail: `${warnings.length} folder convention(s) broken: ${kept.map((w) => w.message).join("; ")}`,
    suggested_action:
      "Fix the frontmatter to match the folder's conventions (get_conventions lists them), then re-run lint_wiki.",
    tool: fix?.tool ?? "update_frontmatter",
    ...(fix ? { tool_args: fix.tool_args } : {}),
    evidence: { warnings: kept, ...(warnings_omitted ? { warnings_omitted } : {}) },
  };
}

function fileProposal(vault: string, path: string, messages: string[]): ConventionProposal {
  return {
    kind: "conventions_file",
    subject: path,
    detail: `${messages.length} problem(s) in this conventions layer: ${messages.join("; ")}`,
    suggested_action:
      "Fix the conventions block of this SCHEMA.md: the messages name the bad entries. A layer that is ignored applies no rules.",
    tool: "read_note",
    tool_args: { vault, path },
    evidence: { messages: messages.slice(0, MAX_SCAN_WARNINGS) },
  };
}

/** The folder a note sits in ("" at the root): the key its resolved conventions are cached under. */
const folderOf = (rel: string): string =>
  rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";

/**
 * The conventions scan as a step generator: one step per note (and per directory of the walk). `keep`
 * is the subject filter the other checks use (generated pages, raw notes, Obsidian's Excluded files).
 * Layers and notes are read under the caller's ACL, through the same walk the other checks use.
 */
export function* conventionsScanSteps(
  scope: ConventionsScope,
  keep: (path: string) => boolean,
  folder?: string,
): ScanSteps<ConventionsScan> {
  const notes: ConventionProposal[] = [];
  const files = new Map<string, string[]>();
  const byFolder = new Map<string, EffectiveConventions>();
  const paths = yield* readableNotesSteps(scope.root, scope.acl, scope.grantedScopes, folder);
  for (const rel of paths) {
    yield;
    if (!keep(rel)) continue;
    try {
      const dir = folderOf(rel);
      let eff = byFolder.get(dir);
      if (eff === undefined) {
        eff = resolveConventions(scope, rel);
        byFolder.set(dir, eff);
      }
      for (const f of eff.fileWarnings) {
        if (!keep(f.path)) continue;
        const messages = files.get(f.path) ?? [];
        if (!messages.includes(f.message)) messages.push(f.message);
        files.set(f.path, messages);
      }
      if (!judges(eff, rel)) continue;
      const { raw } = readNoteBounded(resolveVaultPath(scope.root, rel), NOTE_MAX_BYTES);
      if (raw === null) continue;
      const warnings = checkNote(eff, rel, parseNoteLenient(raw, rel).frontmatter);
      if (warnings.length > 0) notes.push(noteProposal(scope.vaultId, rel, warnings));
    } catch {
      // A note or layer that cannot be read is absent from the scan, as the other checks treat it.
    }
  }
  return {
    notes,
    files: [...files].map(([path, messages]) => fileProposal(scope.vaultId, path, messages)),
  };
}
