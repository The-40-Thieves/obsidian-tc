// Every remediation the public-url doctor checks print links to a section of the deploy recipe. A
// renamed heading would leave the link dead, so each anchor in the source must be a heading there.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/doctor/public-url.ts"), "utf8");
const doc = readFileSync(
  join(here, "../../../docs/src/content/docs/deployment/hosted-clients.md"),
  "utf8",
);
const slug = (h: string) =>
  h
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-");

describe("doctor public-url: recipe anchors", () => {
  it("every anchor a remediation points at is a heading in the deploy recipe", () => {
    const headings = new Set([...doc.matchAll(/^#{2,3} (.+)$/gm)].map((m) => slug(m[1] ?? "")));
    const anchors = [
      ...new Set([...src.matchAll(/anchor: "([a-z0-9-]+)"/g)].map((m) => m[1] ?? "")),
    ];
    // Floors: a broken read of either file would otherwise pass vacuously.
    expect(anchors.length).toBeGreaterThanOrEqual(4);
    expect(headings.size).toBeGreaterThanOrEqual(8);
    for (const a of anchors) expect([a, headings.has(a)]).toEqual([a, true]);
  });
});
