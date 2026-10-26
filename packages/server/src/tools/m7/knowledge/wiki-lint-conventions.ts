// lint_wiki's SCHEMA.md conventions scan. Every note the caller may read is checked against the rules
// of its folder chain (resolved once per folder), and every layer that carries file warnings is reported
// once. The scan returns plain proposals; wiki-lint.ts is their only caller, so this module never imports
// it.
import { checkNote, judges } from "../../../conventions/check";
import { type ConventionsScope, resolveConventions } from "../../../conventions/resolve";
import {
  type ConventionWarning,
  type EffectiveConventions,
  NOTE_MAX_BYTES,
} from "../../../conventions/schema";
import type { ScanSteps } from "../../../util/scan-steps";
import { type Frontmatter, parseNoteLenient } from "../../../vault/frontmatter";
import { isValidTag } from "../../../vault/tags";
import type { ReadRefusals } from "../../read-refusals";
import { capWarningsOut, MAX_SCAN_WARNINGS } from "../../scan-warnings";
import { readableNotesSteps } from "../../wiki-scan";

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

/**
 * The one fix that needs no invented value: a tag to remove, or a scalar with a single allowed value.
 * `current` is the note's value for the property: only a string keeps its type when it is set.
 */
function fixOf(
  vault: string,
  path: string,
  w: ConventionWarning,
  fm: Frontmatter | null,
): { tool: string; tool_args: Record<string, unknown> } | undefined {
  if (w.code !== "value_not_allowed" || w.property === undefined) return undefined;
  if (w.values?.length !== 1) return undefined;
  const value = w.values[0] as string;
  // remove_tag refuses a tag isValidTag rejects, so a proposal for one would never clear the warning.
  if (w.property === "tags" || w.property === "tag")
    return isValidTag(value)
      ? { tool: "remove_tag", tool_args: { vault, path, tag: value, location: "frontmatter" } }
      : undefined;
  // An alias list is not a scalar: setting it to one value would drop the others.
  if (w.property === "aliases" || w.property === "alias") return undefined;
  if (w.allowed?.length !== 1) return undefined;
  // A boolean, number or list set to a text value changes its type: only a string is fixed this way.
  if (typeof fm?.[w.property] !== "string") return undefined;
  return {
    tool: "update_frontmatter",
    tool_args: { vault, path, operation: "set", key: w.property, value: w.allowed[0] },
  };
}

function noteProposal(
  vault: string,
  path: string,
  warnings: ConventionWarning[],
  fm: Frontmatter | null,
): ConventionProposal {
  const { warnings: kept = [], warnings_omitted } = capWarningsOut(warnings);
  // tool_args only when ONE call fixes the whole proposal: a single warning with an unambiguous fix.
  const fix =
    warnings.length === 1 && warnings[0] ? fixOf(vault, path, warnings[0], fm) : undefined;
  const blocking = warnings.filter((w) => w.level === "block").length;
  const fixFirst =
    "Fix the frontmatter to match the folder's conventions (get_conventions lists them), then re-run lint_wiki.";
  return {
    kind: "conventions",
    subject: path,
    detail: `${warnings.length} folder convention(s) broken${blocking > 0 ? ` (${blocking} blocking)` : ""}: ${kept.map((w) => w.message).join("; ")}`,
    suggested_action:
      blocking > 0
        ? `${fixFirst} Edits that keep these violations still pass; an edit that adds a violation marked block, including a different disallowed value, is refused (convention_blocked).`
        : fixFirst,
    tool: fix?.tool ?? "update_frontmatter",
    ...(fix ? { tool_args: fix.tool_args } : {}),
    evidence: { warnings: kept, ...(warnings_omitted ? { warnings_omitted } : {}) },
  };
}

function fileProposal(
  vault: string,
  path: string,
  messages: string[],
  omitted: number,
): ConventionProposal {
  return {
    kind: "conventions_file",
    subject: path,
    detail: `${messages.length} problem(s) in this conventions layer: ${messages.join("; ")}`,
    suggested_action:
      "Fix the conventions block of this SCHEMA.md: the messages name the bad entries. A layer that is ignored applies no rules.",
    tool: "read_note",
    tool_args: { vault, path },
    evidence: {
      messages: messages.slice(0, MAX_SCAN_WARNINGS),
      ...(omitted > 0 ? { file_warnings_omitted: omitted } : {}),
    },
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
  folder: string | undefined,
  refusals: ReadRefusals,
): ScanSteps<ConventionsScan> {
  const notes: ConventionProposal[] = [];
  const blockingNotes: ConventionProposal[] = [];
  const files = new Map<string, string[]>();
  const byFolder = new Map<string, EffectiveConventions>();
  // The chains of different folders share their ancestor layers, so the largest drop is the figure to
  // report: a lower bound on the distinct file warnings that were not kept.
  let filesOmitted = 0;
  // Only layers inside the linted folder are this lint's to report: an ancestor above it is not.
  const inScope = (p: string): boolean =>
    folder === undefined || folder === "" || p.startsWith(`${folder}/`);
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
        for (const f of eff.fileWarnings) {
          if (!keep(f.path) || !inScope(f.path)) continue;
          const messages = files.get(f.path) ?? [];
          if (!messages.includes(f.message)) messages.push(f.message);
          files.set(f.path, messages);
        }
        filesOmitted = Math.max(filesOmitted, eff.fileWarningsOmitted);
      }
      if (!judges(eff, rel)) continue;
      const raw = refusals.read(scope.root, rel);
      if (raw === null || Buffer.byteLength(raw) > NOTE_MAX_BYTES) continue;
      const fm = parseNoteLenient(raw, rel).frontmatter;
      const warnings = checkNote(eff, rel, fm);
      if (warnings.length === 0) continue;
      const proposal = noteProposal(scope.vaultId, rel, warnings, fm);
      // A note with a blocking violation is proposed before the warn-only ones: its fix is the one an edit needs.
      (warnings.some((w) => w.level === "block") ? blockingNotes : notes).push(proposal);
    } catch {
      // A note or layer that cannot be read is absent from the scan, as the other checks treat it.
    }
  }
  return {
    notes: [...blockingNotes, ...notes],
    files: [...files].map(([path, messages]) =>
      fileProposal(scope.vaultId, path, messages, filesOmitted),
    ),
  };
}
