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
import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { FolderAcl } from "../acl";
import { enforcePathAcl } from "../vault/acl-path";
import { type Frontmatter, parseNote, serializeNote } from "../vault/frontmatter";
import { extractLinks } from "../vault/links";
import { noteExists, readNote, writeNoteAtomic } from "../vault/notes-io";
import { contentHash, resolveVaultPath } from "../vault/paths";

// Frontmatter keys the projection owns (regenerated from SQLite each time). Every
// other key in an existing note is preserved verbatim so we never clobber Obsidian's.
// THE-833: "status" joined this set — a retired entity's note says so on its face, not just in
// SQLite, so a human reading the vault directly (the reporter's whole reason for wanting
// materialize:true) sees the same lifecycle state get_entity/query_entity_graph filter on.
const OWNED_FM_KEYS = new Set(["obsidian_tc_id", "entity_type", "status"]);

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
  /** THE-833: 'active' | 'retired' — owned frontmatter, see OWNED_FM_KEYS above. */
  status: string;
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
    status: input.status,
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
  /** THE-833: see RenderEntityInput.status. */
  status: string;
  observations: readonly string[];
  relations: readonly RelationLink[];
  // THE-567: the memory-note path is server-computed (folder + type + name), so it cannot be
  // declared via a central pathAcl extractor (which only sees raw input). Threading the caller's
  // granted scopes through to this handler-side enforcePathAcl call closes that P1.4 gap here
  // instead — the rule-scope gate is enforced, not skipped, just not at the central stage.
  grantedScopes?: Iterable<string>;
}

/**
 * Write (or rewrite) an entity's materialized note. Reads any existing note first so
 * its unknown frontmatter survives the rewrite; the body is regenerated from SQLite.
 * Path-safe (resolveVaultPath containment) + ACL-checked (enforcePathAcl write).
 *
 * Ownership check (review finding, data-loss class): a note already sitting at the target path
 * whose `obsidian_tc_id` is MISSING or DIFFERENT from `input.id` is refused, not silently
 * overwritten. Before this check, `create_entity` for a (type, name) that happened to collide
 * with a hand-written note — or with an orphaned note left behind by a different, unrelated
 * entity that once sanitized to the same path — kept only that note's frontmatter and threw away
 * its ENTIRE BODY, because the body is always fully regenerated from SQLite. `input.id` is the
 * entity actually being written at every call site (memory-projection.ts's rematerialize/
 * materializeProjection always pass the row's own id, freshly generated on create), so this check
 * cannot false-positive on an entity re-materializing its own note — only ever on a genuine
 * foreign note at that exact path. Callers that insert a DB row before calling this (create_entity,
 * link_entities) must roll that row back on this throw, so refusing to materialize never leaves an
 * orphan SQL row behind either — see those handlers' own try/catch.
 */
/** Read the note at `abs` (if any) and report who owns it: `{ exists: false }` when nothing is
 *  there, else `{ exists: true, ownerId, frontmatter }` — `ownerId` is `null` when the note has no
 *  (or a non-string) `obsidian_tc_id`, which reads identically to "not this entity's" everywhere
 *  this is consulted. Shared by `materializeEntity`'s own check below and by
 *  `assertNoteOwnership`, the pre-check lifecycle handlers (rename/unlink/delete_entity) call
 *  BEFORE mutating SQLite — one read, one definition of "who owns this note", never re-derived. */
function readNoteOwner(abs: string): {
  exists: boolean;
  ownerId: string | null;
  frontmatter: Frontmatter | null;
} {
  const ex = noteExists(abs);
  if (!ex.exists || ex.type !== "file") return { exists: false, ownerId: null, frontmatter: null };
  const frontmatter = parseNote(readNote(abs).raw).frontmatter;
  const ownerId =
    frontmatter && typeof frontmatter.obsidian_tc_id === "string"
      ? frontmatter.obsidian_tc_id
      : null;
  return { exists: true, ownerId, frontmatter };
}

function ownershipError(
  rel: string,
  expectedEntityId: string,
  existingOwnerId: string | null,
): Error {
  return err.noteExists(
    "refusing to touch a note this entity does not own " +
      "(its obsidian_tc_id is missing or belongs to a different entity)",
    {
      path: rel,
      entity_id: expectedEntityId,
      ...(existingOwnerId ? { existing_owner_id: existingOwnerId } : {}),
    },
  );
}

/**
 * Pre-check ownership of a vault-relative path BEFORE any write or SQLite mutation touches it —
 * review finding: `rename_entity`'s "seed the new path with the old note's bytes" step used to
 * write directly (bypassing `materializeEntity`'s own check entirely) and could overwrite a
 * foreign note at the destination; `unlink_entities`/`delete_entity` mutated SQLite first and only
 * discovered an ownership refusal afterward, leaving the row changed with nothing to undo it. A
 * no-op when nothing is at `rel`, or when it is already this entity's own note. Callers should run
 * EVERY `assertNoteOwnership` for an operation before making ANY SQLite change for that operation,
 * so a refusal is a pure no-op — nothing to roll back — rather than a partial write.
 */
export function assertNoteOwnership(root: string, rel: string, expectedEntityId: string): void {
  const owner = readNoteOwner(resolveVaultPath(root, rel));
  if (owner.exists && owner.ownerId !== expectedEntityId)
    throw ownershipError(rel, expectedEntityId, owner.ownerId);
}

/**
 * Write (or rewrite) an entity's materialized note. Reads any existing note first so
 * its unknown frontmatter survives the rewrite; the body is regenerated from SQLite.
 * Path-safe (resolveVaultPath containment) + ACL-checked (enforcePathAcl write).
 *
 * Ownership check (review finding, data-loss class): a note already sitting at the target path
 * whose `obsidian_tc_id` is MISSING or DIFFERENT from `input.id` is refused, not silently
 * overwritten. Before this check, `create_entity` for a (type, name) that happened to collide
 * with a hand-written note — or with an orphaned note left behind by a different, unrelated
 * entity that once sanitized to the same path — kept only that note's frontmatter and threw away
 * its ENTIRE BODY, because the body is always fully regenerated from SQLite. `input.id` is the
 * entity actually being written at every call site (memory-projection.ts's rematerialize/
 * materializeProjection always pass the row's own id, freshly generated on create), so this check
 * cannot false-positive on an entity re-materializing its own note — only ever on a genuine
 * foreign note at that exact path. Callers that insert a DB row before calling this (create_entity,
 * link_entities) must roll that row back on this throw, so refusing to materialize never leaves an
 * orphan SQL row behind either — see those handlers' own try/catch. Kept as a SECOND, defense-in-
 * depth check even where a caller already ran `assertNoteOwnership` first (a synchronous handler
 * has no TOCTOU window between the two, but this function is also called from places that never
 * pre-check, e.g. `add_observation`'s materializeProjection).
 */
export function materializeEntity(input: MaterializeInput): {
  vaultPath: string;
  contentHash: string;
} {
  const rel = entityNotePath(input.folder, input.entityType, input.name);
  const abs = resolveVaultPath(input.root, rel);
  enforcePathAcl(input.acl, "write", rel, input.root, input.grantedScopes);
  const owner = readNoteOwner(abs);
  if (owner.exists && owner.ownerId !== input.id)
    throw ownershipError(rel, input.id, owner.ownerId);
  const preserved = owner.frontmatter;
  const content = renderEntityNote({ ...input, preserved });
  writeNoteAtomic(abs, content, true);
  return { vaultPath: rel, contentHash: contentHash(content) };
}

export interface ParsedEntityNote {
  entityId: string | null;
  entityType: string | null;
  name: string | null;
  /** THE-833: 'active' | 'retired' as read off the note's own frontmatter, or null when the note
   *  predates this field (never materialized since, or hand-authored). */
  status: string | null;
  observations: string[];
  relatedTargets: string[];
}

/** Bullet lines under `## <heading>` (case-insensitive), stopping at the next heading; the
 *  literal "_No observations._"/"_No relations._" placeholders renderEntityNote itself emits are
 *  filtered out. Exported for memory-import/basic-memory.ts to reuse — basic-memory's own note
 *  format uses the same `## Observations` / `- bullet` shape (see NOTE-FORMAT.md), and re-deriving
 *  this parser there would drift from this one's exact heading-match / next-heading-stop rules. */
export function sectionBullets(body: string, heading: string): string[] {
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
 *
 * THE-823: deliberately NOT threading a path parameter here. This is exported for graph-integrity
 * verification (today exercised only from tests, on a rendered buffer or an in-memory fixture) —
 * not a call site that reads a specific vault-relative file off disk, so there is no note path to
 * give it. The one legitimate no-path exception among parseNote's callers, not a gap.
 */
export function parseEntityNote(raw: string): ParsedEntityNote {
  const parsed = parseNote(raw);
  const fm = parsed.frontmatter ?? {};
  const h1 = parsed.body.split(/\r?\n/).find((l) => /^#\s+/.test(l));
  return {
    entityId: typeof fm.obsidian_tc_id === "string" ? fm.obsidian_tc_id : null,
    entityType: typeof fm.entity_type === "string" ? fm.entity_type : null,
    status: typeof fm.status === "string" ? fm.status : null,
    name: h1 ? h1.replace(/^#\s+/, "").trim() : null,
    observations: sectionBullets(parsed.body, OBSERVATIONS_HEADING),
    relatedTargets: extractLinks(parsed.body)
      .filter((l) => l.kind === "wikilink")
      .map((l) => l.target),
  };
}
