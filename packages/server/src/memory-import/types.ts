// THE-1124 — shared types for `obsidian-tc memory import`. One shape both adapters
// (basic-memory, claude-code-memory) parse into, so the plan/apply/report code downstream
// never branches on which adapter produced an entity.
export interface ParsedRelation {
  relationType: string;
  targetName: string;
}

export interface ParsedEntity {
  /** Forward-slash path relative to the import root (`<dir>`) — never absolute. This is the
   *  provenance key: it becomes the entity note's `source_path` frontmatter and is what a
   *  re-run keys idempotency on (see apply.ts). */
  sourcePath: string;
  entityType: string;
  name: string;
  observations: string[];
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
