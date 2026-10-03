// query_base counts frontmatter property links, as Obsidian's Bases does: `file.links` is "all
// internal links in the note, including frontmatter" and `file.hasLink()` is satisfied by a
// property link. These pin the `link` source, `file.hasLink()` and `file.links` together.
import { describe, expect, it } from "vitest";
import { makeM3Vault } from "./m3-helpers";

const VIEW = "views:\n  - name: V\n    type: table\n";
const HAS_TARGET = `filters: file.hasLink("Target")\n${VIEW}`;
const LINK_SOURCE = `source:\n  type: link\n  value: Target\n${VIEW}`;
const LINKS_COLUMN = `filters: file.hasLink("Target")\nformulas:\n  links: file.links\n${VIEW}`;

const NOTES: Record<string, string> = {
  "Target.md": "---\n---\nthe target",
  "prop.md": '---\nup: "[[Target]]"\n---\nno body link',
  "list.md": '---\nrelated: ["[[Target]]", "[[Other]]"]\n---\nx',
  "alias.md": '---\nup: "[[Target|alias]]"\n---\nx',
  "body.md": "---\nstatus: a\n---\nsee [[Target]]",
  "both.md": '---\nup: "[[Target]]"\n---\nalso [[Target]] and [[Other]]',
  "none.md": "---\nstatus: a\n---\nno links at all",
};

type Row = { note_path: string; columns: Record<string, unknown> };

async function rows(base: string): Promise<Row[]> {
  const v = makeM3Vault({ files: { ...NOTES, "q.base": base } });
  try {
    const q = await v.call("query_base", { vault: "test", path: "q.base" });
    expect(q.ok).toBe(true);
    return q.ok ? (q.data as { items: Row[] }).items : [];
  } finally {
    v.cleanup();
  }
}

const MATCHING = ["alias.md", "body.md", "both.md", "list.md", "prop.md"];

describe("query_base: frontmatter property links (Bases parity)", () => {
  it("file.hasLink() matches property-only, list, alias and body links; not a linkless note", async () => {
    const got = (await rows(HAS_TARGET)).map((r) => r.note_path).sort();
    expect(got).toEqual(MATCHING);
  });

  it("the `link` source matches the same notes", async () => {
    const got = (await rows(LINK_SOURCE)).map((r) => r.note_path).sort();
    expect(got).toEqual(MATCHING);
  });

  it("file.links lists property links before body links, de-duplicated across sources", async () => {
    const by = Object.fromEntries(
      (await rows(LINKS_COLUMN)).map((r) => [r.note_path, r.columns.links]),
    );
    expect(by["prop.md"]).toEqual(["Target"]);
    expect(by["list.md"]).toEqual(["Target", "Other"]);
    expect(by["alias.md"]).toEqual(["Target"]);
    expect(by["body.md"]).toEqual(["Target"]);
    // property `Target` + body `Target` + body `Other`: the repeat across sources is listed once.
    expect(by["both.md"]).toEqual(["Target", "Other"]);
    expect(by["none.md"]).toBeUndefined();
  });

  it("file.links of a linkless note is empty", async () => {
    const got = await rows(`formulas:\n  links: file.links\n${VIEW}`);
    expect(got.find((r) => r.note_path === "none.md")?.columns.links).toEqual([]);
  });

  it("a note whose frontmatter YAML is broken still counts its body links", async () => {
    const v = makeM3Vault({
      files: {
        "Target.md": "x",
        "bad.md": "---\nup: [unclosed\n---\nsee [[Target]]",
        "q.base": HAS_TARGET,
      },
    });
    try {
      const q = await v.call("query_base", { vault: "test", path: "q.base" });
      expect(q.ok).toBe(true);
      if (q.ok) {
        const d = q.data as { items: Row[] };
        expect(d.items.map((i) => i.note_path)).toEqual(["bad.md"]);
      }
    } finally {
      v.cleanup();
    }
  });
});
