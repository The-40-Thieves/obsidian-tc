// Obsidian 1.14 per-view `groupOrder`: listed groups only, in list order; `null` is the
// no-value group; a non-array value is ignored; the list overrides groupBy.direction.
import { describe, expect, it } from "vitest";
import { parseBase, serializeBase } from "../src/formats/base";
import { makeM3Vault } from "./m3-helpers";

const KANBAN = `views:
  - type: kanban
    name: Projects
    groupBy:
      property: note.status
      direction: ASC
    groupOrder:
      - Planned
      - In progress
      - Done
`;

const withOrder = (groupOrder: string, direction = "ASC", limit?: number): string =>
  `views:
  - type: table
    name: V
    groupBy:
      property: note.status
      direction: ${direction}
${limit === undefined ? "" : `    limit: ${limit}\n`}    groupOrder: ${groupOrder}
`;

const FILES = {
  "a.md": "---\ntags: [t]\nstatus: Done\n---\na",
  "b.md": "---\ntags: [t]\nstatus: Planned\n---\nb",
  "c.md": "---\ntags: [t]\nstatus: In progress\n---\nc",
  "d.md": "---\ntags: [t]\nstatus: Archived\n---\nd",
  "e.md": "---\ntags: [t]\n---\ne",
  "f.md": "---\ntags: [t]\nstatus: Planned\n---\nf",
};

async function groupsOf(
  base: string,
  files = FILES,
): Promise<{ total: number; groups: unknown[] }> {
  const v = makeM3Vault({ files: { ...files, "kanban.base": base } });
  try {
    const q = await v.call("query_base", { vault: "test", path: "kanban.base" });
    expect(q.ok).toBe(true);
    if (!q.ok) throw new Error("query_base failed");
    const d = q.data as { total: number; items: Array<{ group?: unknown }> };
    return { total: d.total, groups: d.items.map((i) => i.group ?? null) };
  } finally {
    v.cleanup();
  }
}

describe("query_base honors per-view groupOrder (Obsidian 1.14)", () => {
  it("lists only the named groups, in the listed order", async () => {
    const r = await groupsOf(KANBAN);
    expect(r.groups).toEqual(["Planned", "Planned", "In progress", "Done"]);
    expect(r.total).toBe(4);
  });

  it("hides groups that are not listed (Archived and the no-value note)", async () => {
    const r = await groupsOf(withOrder("[Done]"));
    expect(r.groups).toEqual(["Done"]);
  });

  it("an empty list hides every group", async () => {
    const r = await groupsOf(withOrder("[]"));
    expect(r.total).toBe(0);
    expect(r.groups).toEqual([]);
  });

  it("a null entry selects the group of notes with no value", async () => {
    const r = await groupsOf(withOrder("[Done, null]"));
    expect(r.groups).toEqual(["Done", null]);
    expect(r.total).toBe(2);
  });

  it("a non-array groupOrder is ignored and every group is shown", async () => {
    const r = await groupsOf(withOrder("Done"));
    expect(r.groups).toEqual([null, "Archived", "Done", "In progress", "Planned", "Planned"]);
  });

  it("hidden groups do not consume the view limit", async () => {
    // Unfiltered ASC order puts Archived and Done first; with limit 2 the listed
    // groups must still be the rows returned.
    const r = await groupsOf(withOrder("[Planned, Done]", "ASC", 2));
    expect(r.groups).toEqual(["Planned", "Planned"]);
    expect(r.total).toBe(2);
  });

  it("groupOrder overrides groupBy.direction DESC", async () => {
    const r = await groupsOf(withOrder("[Done, Planned]", "DESC"));
    expect(r.groups).toEqual(["Done", "Planned", "Planned"]);
  });

  it("compares stringified values so a number matches its string form", async () => {
    const base = withOrder("[2026]").replace("note.status", "note.year");
    const r = await groupsOf(base, {
      "y1.md": "---\nyear: 2026\n---\nx",
      "y2.md": '---\nyear: "2026"\n---\ny',
      "y3.md": "---\nyear: 2025\n---\nz",
    });
    expect(r.groups).toEqual([2026, "2026"]);
  });
});

describe("1.14 kanban .base with groupOrder round-trips byte-stable on keys", () => {
  it("parseBase and serializeBase keep groupOrder and the view keys", () => {
    const once = parseBase(KANBAN).raw;
    const text = serializeBase(once);
    const twice = parseBase(text).raw;
    expect(twice).toEqual(once);
    const view = (twice.views as Array<Record<string, unknown>>)[0];
    expect(Object.keys(view ?? {})).toEqual(["type", "name", "groupBy", "groupOrder"]);
    expect(view?.groupOrder).toEqual(["Planned", "In progress", "Done"]);
  });
});
