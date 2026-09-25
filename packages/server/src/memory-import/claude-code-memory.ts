// THE-1124 — claude-code-memory adapter. Maps one Claude Code MEMORY.md per-fact file to one
// ParsedEntity. The real shape (verified against this box's own
// ~/.claude/projects/-home-ubuntu/memory/*.md, a small sanitized subset of which is fixtured at
// test/fixtures/memory-import/claude-code-memory/):
//
//   ---
//   name: feedback-example-name
//   description: One-line summary shown in the index.
//   metadata:
//     type: feedback
//     originSessionId: 00000000-0000-0000-0000-000000000000
//     modified: 2026-01-01T00:00:00.000Z
//   ---
//
//   Prose body, possibly citing another fact by its `name`: [[reference-other-fact]].
//
// -> { entityType: "feedback", name: "feedback-example-name",
//      observations: ["Prose body, possibly citing another fact by its `name`: [[reference-other-fact]]."],
//      relations: [{ relationType: "relates_to", targetName: "reference-other-fact" }] }
//
// The index file (MEMORY.md itself — one line per entry, linking to the per-fact files) carries
// no entity of its own and is skipped by the caller (plan.ts) before this parser ever sees it;
// this module only knows how to read a single fact file.
//
// Same frontmatter parser reuse as basic-memory.ts (vault/frontmatter.ts's parseNote), and the
// same extractLinks (vault/links.ts) for `[[name]]` citations — Claude Code memory files have no
// typed relation syntax of their own (unlike basic-memory's `- relation_type [[Target]]`), so
// every wikilink becomes a "relates_to" relation; see the docs page for why that default was
// chosen over inventing a syntax the source files don't have.
import { isFrontmatterYamlError, parseNote } from "../vault/frontmatter";
import { extractLinks } from "../vault/links";
import type { ParsedRelation, ParseFileResult } from "./types";

const RELATION_TYPE = "relates_to";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseClaudeCodeMemoryFile(raw: string, sourcePath: string): ParseFileResult {
  if (!raw.trim()) return { ok: false, reason: "empty file" };
  let parsed: ReturnType<typeof parseNote>;
  try {
    parsed = parseNote(raw, sourcePath);
  } catch (e) {
    if (isFrontmatterYamlError(e))
      return { ok: false, reason: `malformed frontmatter: ${e.message}` };
    throw e;
  }
  const fm = parsed.frontmatter;
  if (!fm) return { ok: false, reason: "missing frontmatter (no name/metadata.type)" };
  const name = typeof fm.name === "string" ? fm.name.trim() : "";
  if (!name) return { ok: false, reason: "missing frontmatter.name" };
  const metadata = isRecord(fm.metadata) ? fm.metadata : undefined;
  const entityType =
    metadata && typeof metadata.type === "string" && metadata.type.trim().length > 0
      ? metadata.type.trim()
      : "note";
  // The stored `observations` column is newline-delimited (memory/entities.ts's
  // serializeObservations/parseObservations — one observation per LINE), so a multi-line prose
  // body cannot be passed through verbatim as a single observation: it would round-trip back as
  // several. Collapse it to one line first.
  const body = parsed.body.trim().replace(/\s+/g, " ");
  const observations = body.length > 0 ? [body] : [];
  const seen = new Set<string>();
  const relations: ParsedRelation[] = [];
  for (const link of extractLinks(body)) {
    if (link.kind !== "wikilink" || seen.has(link.target)) continue;
    seen.add(link.target);
    relations.push({ relationType: RELATION_TYPE, targetName: link.target });
  }
  return { ok: true, entity: { sourcePath, entityType, name, observations, relations } };
}
