// Memory-entity .md materialization codec (M5 / THE-181, G2.1 Domain 22).
//
// SQLite is the source of truth; a materialized note is a REGENERABLE PROJECTION so
// the [[link]] graph resolves in Obsidian's own graph view. The round-trip discipline
// matches M3: re-materializing PRESERVES unknown frontmatter (Obsidian's own keys —
// aliases, cssclasses, etc.) and only owns a minimal set; the body is fully
// regenerated from SQLite so re-materializing identical state is byte-idempotent.
// parseEntityNote reads a note back (frontmatter + observations + [[link]] targets)
// for graph-integrity checks; it relies on the shared extractLinks parser, so aliases
// ([[a|b]]), headings ([[a#h]]) and blocks ([[a#^id]]) all resolve to the bare target.
import type { FolderAcl } from "../acl";
import { enforcePathAcl } from "../vault/acl-path";
import { type Frontmatter, parseNote, serializeNote } from "../vault/frontmatter";
import { extractLinks } from "../vault/links";
import { noteExists, readNote, writeNoteAtomic } from "../vault/notes-io";
import { contentHash, resolveVaultPath } from "../vault/paths";

// Frontmatter keys the projection owns (regenerated from SQLite each time). Every
// other key in an existing note is preserved verbatim so we never clobber Obsidian's.
const OWNED_FM_KEYS = new Set(["obsidian_tc_id", "entity_type"]);

const OBSERVATIONS_HEADING = "Observations";
const RELATED_HEADING = "Related";

/** Make one path segment filesystem-safe: drop separators, wikilink/heading sigils,
 *  and reserved characters. Never yields an empty segment. */
function sanitizeSegment(s: string): string {
  const cleaned = s
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : "untitled";
}

/** Vault-relative path for an entity's materialized note: <folder>/<type>/<name>.md.
 *  Both type and name are sanitized to single segments — no traversal can escape. */
export function entityNotePath(folder: string, entityType: string, name: string): string {
  const f = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${f}/${sanitizeSegment(entityType)}/${sanitizeSegment(name)}.md`;
}

export interface RelationLink {
  relationType: string;
  targetName: string;
}

export interface RenderEntityInput {
  id: string;
  entityType: string;
  name: string;
  observations: readonly string[];
  relations: readonly RelationLink[];
  preserved?: Frontmatter | null;
}

function stripOwned(fm: Frontmatter | null | undefined): Frontmatter {
  const out: Frontmatter = {};
  if (fm) for (const [k, v] of Object.entries(fm)) if (!OWNED_FM_KEYS.has(k)) out[k] = v;
  return out;
}

/** Render an entity to note text: owned frontmatter first, then any preserved keys,
 *  then a deterministic body (H1 + Observations + Related [[links]]). Pure + stable. */
export function renderEntityNote(input: RenderEntityInput): string {
  const fm: Frontmatter = {
    obsidian_tc_id: input.id,
    entity_type: input.entityType,
    ...stripOwned(input.preserved),
  };
  const lines: string[] = [`# ${input.name}`, "", `## ${OBSERVATIONS_HEADING}`, ""];
  if (input.observations.length === 0) lines.push("_No observations._", "");
  else {
    for (const o of input.observations) lines.push(`- ${o}`);
    lines.push("");
  }
  lines.push(`## ${RELATED_HEADING}`, "");
  const rels = [...input.relations].sort(
    (a, b) =>
      a.targetName.localeCompare(b.targetName) || a.relationType.localeCompare(b.relationType),
  );
  if (rels.length === 0) lines.push("_No relations._", "");
  else {
    for (const r of rels) lines.push(`- ${r.relationType} [[${r.targetName}]]`);
    lines.push("");
  }
  return serializeNote(fm, lines.join("\n"));
}

export interface MaterializeInput {
  root: string;
  acl: FolderAcl | undefined;
  folder: string;
  id: string;
  entityType: string;
  name: string;
  observations: readonly string[];
  relations: readonly RelationLink[];
}

/**
 * Write (or rewrite) an entity's materialized note. Reads any existing note first so
 * its unknown frontmatter survives the rewrite; the body is regenerated from SQLite.
 * Path-safe (resolveVaultPath containment) + ACL-checked (enforcePathAcl write).
 */
export function materializeEntity(input: MaterializeInput): {
  vaultPath: string;
  contentHash: string;
} {
  const rel = entityNotePath(input.folder, input.entityType, input.name);
  const abs = resolveVaultPath(input.root, rel);
  enforcePathAcl(input.acl, "write", rel, input.root);
  let preserved: Frontmatter | null = null;
  const ex = noteExists(abs);
  if (ex.exists && ex.type === "file") preserved = parseNote(readNote(abs).raw).frontmatter;
  const content = renderEntityNote({ ...input, preserved });
  writeNoteAtomic(abs, content, true);
  return { vaultPath: rel, contentHash: contentHash(content) };
}

export interface ParsedEntityNote {
  entityId: string | null;
  entityType: string | null;
  name: string | null;
  observations: string[];
  relatedTargets: string[];
}

function sectionBullets(body: string, heading: string): string[] {
  const lines = body.split(/\r?\n/);
  const want = `## ${heading}`.toLowerCase();
  let i = lines.findIndex((l) => l.trim().toLowerCase() === want);
  if (i < 0) return [];
  const out: string[] = [];
  for (i += 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (/^#{1,6}\s+/.test(l)) break; // next heading ends the section
    const m = /^\s*-\s+(.*\S)\s*$/.exec(l);
    if (m?.[1] && m[1] !== "_No observations._" && m[1] !== "_No relations._") out.push(m[1]);
  }
  return out;
}

/**
 * Parse a materialized note back into its entity facts: owned frontmatter, the H1
 * name, the Observations bullets, and every [[link]] target in the body. Used for
 * graph-integrity verification; dangling links are returned as-is (the caller decides).
 */
export function parseEntityNote(raw: string): ParsedEntityNote {
  const parsed = parseNote(raw);
  const fm = parsed.frontmatter ?? {};
  const h1 = parsed.body.split(/\r?\n/).find((l) => /^#\s+/.test(l));
  return {
    entityId: typeof fm.obsidian_tc_id === "string" ? fm.obsidian_tc_id : null,
    entityType: typeof fm.entity_type === "string" ? fm.entity_type : null,
    name: h1 ? h1.replace(/^#\s+/, "").trim() : null,
    observations: sectionBullets(parsed.body, OBSERVATIONS_HEADING),
    relatedTargets: extractLinks(parsed.body)
      .filter((l) => l.kind === "wikilink")
      .map((l) => l.target),
  };
}
