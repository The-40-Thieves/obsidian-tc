// THE-1124 — shared types for `obsidian-tc memory import`. One shape both adapters
// (basic-memory, claude-code-memory) parse into, so the plan/apply/report code downstream
// never branches on which adapter produced an entity.
export interface ParsedRelation {
  relationType: string;
  targetName: string;
}

/** THE-1130: one imported observation, with its (optional) supersession key extracted — see
 *  memory-import/basic-memory.ts's `[category] text` -> `{key: category, text}` mapping (only
 *  when `category` passes add_observation's key regex; otherwise the whole bracketed string is
 *  kept as literal `text` with `key: null`, same as a bullet this repo's own note renderer never
 *  produced). claude-code-memory's adapter has no analogous convention, so its observations are
 *  always `key: null`. */
export interface ParsedObservation {
  text: string;
  key: string | null;
}

export interface ParsedEntity {
  /** Forward-slash path relative to the import root (`<dir>`) — never absolute. This is the
   *  provenance key: it becomes the entity note's `source_path` frontmatter and is what a
   *  re-run keys idempotency on (see apply.ts). */
  sourcePath: string;
  entityType: string;
  name: string;
  observations: ParsedObservation[];
  relations: ParsedRelation[];
}

export interface SkippedFile {
  sourcePath: string;
  reason: string;
}

export interface ParsedSource {
  entities: ParsedEntity[];
  /** Files the walk or a parser declined to import, each with a human-readable reason —
   *  symlinks, path escapes, malformed frontmatter, the claude-code-memory index file, etc. */
  skipped: SkippedFile[];
}

export type ImportAdapterName = "basic-memory" | "claude-code-memory";

export type ParseFileResult = { ok: true; entity: ParsedEntity } | { ok: false; reason: string };
