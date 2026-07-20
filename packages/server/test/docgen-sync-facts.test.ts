// docgen sync-facts: the eval → docs bridge. Counts the private golden set (derived) and merges it
// into docs/project-facts.json without clobbering the curated claim (enrichmentNdcgGain).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  countGoldenQueries,
  mergeFacts,
  type ProjectFacts,
  serializeFacts,
} from "../scripts/docgen/sync-facts";

const base: ProjectFacts = {
  _note: "keep me",
  goldenSetSize: 136,
  enrichmentNdcgGain: "+0.223 nDCG",
};

describe("sync-facts", () => {
  it("counts queries from the committed example golden set", () => {
    const yamlText = readFileSync(
      fileURLToPath(new URL("../eval/multi-hop-golden-set.example.yaml", import.meta.url)),
      "utf8",
    );
    expect(countGoldenQueries(yamlText)).toBeGreaterThan(0);
  });

  it("rejects a golden set with no queries array", () => {
    expect(() => countGoldenQueries("notqueries: []")).toThrow();
  });

  it("updates the derived fact without touching the curated claim", () => {
    const next = mergeFacts(base, { goldenSetSize: 250 });
    expect(next.goldenSetSize).toBe(250);
    expect(next.enrichmentNdcgGain).toBe("+0.223 nDCG"); // curated claim preserved
    expect(next._note).toBe("keep me");
  });

  it("updates the curated claim only when supplied, independently", () => {
    const next = mergeFacts(base, { enrichmentNdcgGain: "+0.180 nDCG" });
    expect(next.enrichmentNdcgGain).toBe("+0.180 nDCG");
    expect(next.goldenSetSize).toBe(136); // derived fact untouched
  });

  it("serializes in the file's canonical shape (_note first, trailing newline)", () => {
    const out = serializeFacts(mergeFacts(base, { goldenSetSize: 250 }));
    expect(out.endsWith("}\n")).toBe(true);
    expect(out.indexOf('"_note"')).toBeLessThan(out.indexOf('"goldenSetSize"'));
    expect(JSON.parse(out)).toEqual({
      _note: "keep me",
      goldenSetSize: 250,
      enrichmentNdcgGain: "+0.223 nDCG",
    });
  });
});
