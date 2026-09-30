// The tag vocabulary is explained in two hand-written places: the docs site's Tool tags table and
// ADR-0006. Neither is generated, so this keeps them from drifting from mcp/tool-tags.ts: every
// vocabulary tag must be described, with the right source, and no table row may name a tag the
// vocabulary lacks.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOL_TAG_VOCABULARY } from "../src/mcp/tool-tags";

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");
const DOCS = read("../../../docs/src/content/docs/tools/index.md");
const ADR = read("../../../docs/adr/0006-the-default-surface-is-the-triad.md");

const SOURCE_LABEL = { derived: "derived", declared: "declared", both: "derived and declared" };

// `domain:<name>` rows stand for the whole family; the per-domain entries are derived from
// TOOL_DOMAINS, so the docs carry one row.
const docKey = (tag: string): string => (tag.startsWith("domain:") ? "domain:<name>" : tag);

function rowsOf(md: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of md.split("\n")) {
    const m = /^\| `([a-z:<>-]+)` \| (derived and declared|derived|declared) \|/.exec(line);
    if (m?.[1] && m[2]) rows.set(m[1], m[2]);
  }
  return rows;
}

describe("tag vocabulary docs", () => {
  const rows = rowsOf(DOCS);

  it("the docs site describes every vocabulary tag with its source", () => {
    expect(rows.size).toBeGreaterThan(10);
    for (const [tag, spec] of Object.entries(TOOL_TAG_VOCABULARY)) {
      expect(rows.get(docKey(tag)), `docs row for ${tag}`).toBe(SOURCE_LABEL[spec.source]);
    }
  });

  it("the docs site lists no tag the vocabulary lacks", () => {
    const known = new Set(Object.keys(TOOL_TAG_VOCABULARY).map(docKey));
    for (const tag of rows.keys()) expect(known.has(tag), `unknown tag row ${tag}`).toBe(true);
  });

  it("ADR-0006 names every vocabulary tag", () => {
    for (const tag of Object.keys(TOOL_TAG_VOCABULARY)) {
      expect(ADR, tag).toContain(`\`${docKey(tag)}\``);
    }
  });
});
