// Obsidian Bases filter evaluation: a `.base` view evaluates its filter tree against every note in
// scope, so per-note evaluation cost scales with vault size.
import { test } from "vitest";
import { type BasesNoteCtx, evaluateBasesFilter } from "../src/formats/bases-expr";
import { rng } from "./fixtures";

const STATUSES = ["active", "done", "backlog"] as const;
const TAGS = ["project", "idea", "reading", "daily"] as const;

const r = rng(5);
const notes: BasesNoteCtx[] = Array.from({ length: 500 }, (_, i) => ({
  path: `projects/note ${i}.md`,
  frontmatter: {
    status: STATUSES[i % STATUSES.length],
    priority: Math.floor(r() * 5),
    due: "2026-11-01",
  },
  tags: [TAGS[i % TAGS.length] as string, TAGS[(i + 1) % TAGS.length] as string],
  links: [`note ${(i + 1) % 500}`],
}));

const filter = {
  and: [
    'file.hasTag("project")',
    { or: ['status == "active"', "priority > 2"] },
    { not: ['status == "done"'] },
  ],
};

test("bases filter", async ({ bench }) => {
  await bench("evaluateBasesFilter (500 notes)", () => {
    let hits = 0;
    for (const n of notes) if (evaluateBasesFilter(filter, n)) hits++;
    return hits;
  }).run();
});
