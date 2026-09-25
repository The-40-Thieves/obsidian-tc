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

import { isFrontmatterYamlError, parseNote } from "../vault/frontmatter";
import { extractLinks } from "../vault/links";
import type { ParsedRelation, ParseFileResult } from "./types";

function basename(sourcePath: string): string {
  return sourcePath.split("/").pop() ?? sourcePath;
}

/** Bullet lines under `## <heading>` (case-insensitive singular/plural — basic-memory's own docs
 *  use "Observations"/"Relations", both plural), stopping at the next heading. Returns the raw
 *  bullet text (everything after `- `), same convention memory/materialize.ts's own
 *  sectionBullets uses for the entity-note round trip. */
function sectionLines(body: string, heading: string): string[] {
  const lines = body.split(/\r?\n/);
  const want = `## ${heading}`.toLowerCase();
  const start = lines.findIndex((l) => l.trim().toLowerCase() === want);
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (/^#{1,6}\s+/.test(l)) break;
    const m = /^\s*-\s+(.*\S)\s*$/.exec(l);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

function parseRelationLine(line: string): ParsedRelation | null {
  const linkStart = line.indexOf("[[");
  if (linkStart < 0) return null;
  const relationType = line.slice(0, linkStart).trim();
  if (!relationType) return null;
  const link = extractLinks(line).find((l) => l.kind === "wikilink");
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
  const observations = sectionLines(parsed.body, "Observations");
  const relations = sectionLines(parsed.body, "Relations")
    .map(parseRelationLine)
    .filter((r): r is ParsedRelation => r !== null);
  return { ok: true, entity: { sourcePath, entityType, name, observations, relations } };
}
