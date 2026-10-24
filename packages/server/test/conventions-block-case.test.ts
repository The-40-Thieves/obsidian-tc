// Case is not a rule: a `.Md` or `.MD` file is a note, so the block gate, the advisory check and
// lint_wiki judge it exactly as they judge `.md`.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKED, expectMissingRequired, STATUS_RULES, withVault } from "./conventions-helpers";
import type { TestVault } from "./m1-helpers";
import { makeWikiHarness } from "./wiki-test-helpers";

const MEETING = "meetings/SCHEMA.md";
const rules = STATUS_RULES;

const upsert = (v: TestVault, path: string) =>
  v.call("write_note", { vault: "test", mode: "upsert", path, content: "x\n" });

describe("a note with an upper-case extension is judged like .md", () => {
  for (const name of ["q.Md", "q.MD"]) {
    it(`refuses a block violation written to ${name} and writes nothing`, async () => {
      await withVault({ ...CHECKED, files: { [MEETING]: rules("block") } }, async (v) => {
        const r = await upsert(v, `meetings/${name}`);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe("convention_blocked");
        expect(existsSync(join(v.root, "meetings", name))).toBe(false);
      });
    });

    it(`advises on a warn violation written to ${name}`, async () => {
      await withVault({ ...CHECKED, files: { [MEETING]: rules("warn") } }, async (v) => {
        const r = await upsert(v, `meetings/${name}`);
        expectMissingRequired(r, `meetings/${name}`, MEETING);
      });
    });
  }

  it("lint_wiki proposes a conventions fix for a .MD note", async () => {
    const hh = makeWikiHarness({
      files: {
        "wiki/SCHEMA.md": "---\nconventions:\n  frontmatter:\n    required: [type]\n---\n# rules\n",
        "wiki/NoType.MD": "---\nstatus: draft\n---\nno type\n",
      },
      acl: { readPaths: ["wiki/**"] },
    });
    const d = (await hh.data("lint_wiki", { checks: ["conventions"] })) as Record<string, any>;
    const p = (d.proposals as Array<Record<string, any>>).find(
      (x) => x.kind === "conventions" && x.subject === "wiki/NoType.MD",
    );
    expect(p?.evidence.warnings).toEqual([
      expect.objectContaining({ code: "missing_required", property: "type" }),
    ]);
  });
});
