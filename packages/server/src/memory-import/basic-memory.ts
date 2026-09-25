// THE-1124 — basic-memory adapter. Maps one basic-memory note (frontmatter `title`/`type`,
// `## Observations` / `## Relations` sections — see NOTE-FORMAT.md and
// docs/ai-assistant-guide-extended.md in basicmachines-co/basic-memory) to one ParsedEntity:
//
//   ---
//   title: Coffee Brewing Methods
//   type: note
//   tags: [coffee, brewing]
//   permalink: coffee-brewing-methods
//   ---
//   ## Observations
//   - [method] Pour over provides more flavor clarity than French press
//   ## Relations
//   - relates_to [[Coffee Bean Origins]]
//
// -> { entityType: "note", name: "Coffee Brewing Methods",
//      observations: ["[method] Pour over provides more flavor clarity than French press"],
//      relations: [{ relationType: "relates_to", targetName: "Coffee Bean Origins" }] }
//
// Reuses the repo's own frontmatter parser (vault/frontmatter.ts's parseNote) rather than a
// second YAML parser — it already throws a structured, path-annotated error on malformed YAML
// (isFrontmatterYamlError), which is exactly the "malformed frontmatter, skipped with reason"
// case this adapter needs — and extractLinks (vault/links.ts) for the `[[Target]]` syntax, which
// already handles aliases/headings/blocks so a `[[Target|alias]]` or `[[Target#heading]]` relation
// resolves to the bare target the same way the vault's own link graph does.

import { sectionBullets } from "../memory/materialize";
import { isFrontmatterYamlError, parseNote } from "../vault/frontmatter";
import { extractLinks } from "../vault/links";
import type { ParsedRelation, ParseFileResult } from "./types";

function basename(sourcePath: string): string {
  return sourcePath.split("/").pop() ?? sourcePath;
}

/** A `- relation_type [[Target]]` bullet -> a relation, or null when the line carries no
 *  `relation_type` text before the link (a bare `- [[Target]]` with nothing to type it) or the
 *  link is inside inline code / a fenced block (extractLinks still reports these, flagged
 *  `inCodeblock`, so the caller decides — a link inside a code sample is example text, not a
 *  real relation to create). */
function parseRelationLine(line: string): ParsedRelation | null {
  const linkStart = line.indexOf("[[");
  if (linkStart < 0) return null;
  const relationType = line.slice(0, linkStart).trim();
  if (!relationType) return null;
  const link = extractLinks(line).find((l) => l.kind === "wikilink" && !l.inCodeblock);
  if (!link) return null;
  return { relationType, targetName: link.target };
}

export function parseBasicMemoryFile(raw: string, sourcePath: string): ParseFileResult {
  if (!raw.trim()) return { ok: false, reason: "empty file" };
  let parsed: ReturnType<typeof parseNote>;
  try {
    parsed = parseNote(raw, sourcePath);
  } catch (e) {
    if (isFrontmatterYamlError(e))
      return { ok: false, reason: `malformed frontmatter: ${e.message}` };
    throw e;
  }
  const fm = parsed.frontmatter ?? {};
  const title = typeof fm.title === "string" ? fm.title.trim() : "";
  const name = title || basename(sourcePath).replace(/\.md$/i, "");
  if (!name) return { ok: false, reason: "no title and no usable filename" };
  const entityType =
    typeof fm.type === "string" && fm.type.trim().length > 0 ? fm.type.trim() : "note";
  // sectionBullets is memory/materialize.ts's own `## <heading>` bullet parser, reused verbatim
  // (not re-derived) — basic-memory's note format uses the same `## Observations` / `- bullet`
  // shape as the entity notes this importer writes.
  const observations = sectionBullets(parsed.body, "Observations");
  const relations = sectionBullets(parsed.body, "Relations")
    .map(parseRelationLine)
    .filter((r): r is ParsedRelation => r !== null);
  return { ok: true, entity: { sourcePath, entityType, name, observations, relations } };
}
