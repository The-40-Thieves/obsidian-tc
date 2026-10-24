// lint_wiki's `conventions` and `conventions_file` kinds: the SCHEMA.md folder conventions a note breaks
// (one proposal per note, tool_args only for an unambiguous fix) and the layers with file warnings (one
// proposal per layer). Both are caller-scoped, skip the generated wiki pages and raw notes, and leave the
// existing kinds' output as it was.
import { describe, expect, it } from "vitest";
import { LINT_CHECKS } from "../src/tools/m7/knowledge/wiki-lint";
import { conventionsScanSteps } from "../src/tools/m7/knowledge/wiki-lint-conventions";
import { drainYielding } from "../src/util/scan-steps";
import { makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

const layer = (body: string): string => `---\nconventions:\n${body}\n---\n# rules\n`;

const RULES = layer(
  "  version: 1\n  frontmatter:\n    required: [type]\n    values:\n      status: [draft]\n      kind: [a, b]\n      tags: [project, area/*]",
);

const FILES: Record<string, string> = {
  "wiki/SCHEMA.md": RULES,
  "wiki/Good.md": "---\ntype: research\nstatus: draft\nkind: a\ntags: [project]\n---\nbody\n",
  "wiki/NoType.md": "---\nstatus: draft\n---\nno type\n",
  "wiki/BadTag.md": "---\ntype: research\ntags: [project, nope]\n---\nbad tag\n",
  "wiki/BadStatus.md": "---\ntype: research\nstatus: stale\n---\nbad status\n",
  "wiki/BadKind.md": "---\ntype: research\nkind: z\n---\nbad kind\n",
  "wiki/Plain.md": "Not front-matter at all.\n",
};

const LEGACY_CHECKS = LINT_CHECKS.filter((c) => !c.startsWith("conventions"));

let h: WikiHarness | undefined;

function fixture(files: Record<string, string> = FILES, acl?: object): WikiHarness {
  h = makeWikiHarness({
    files,
    acl: acl ?? { readPaths: ["wiki/**", "raw/**", "private/**"] },
  });
  return h;
}

async function lint(
  hh: WikiHarness,
  input: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  return hh.data("lint_wiki", input);
}

const ofKind = (d: Record<string, any>, kind: string) =>
  (d.proposals as Array<Record<string, any>>).filter((p) => p.kind === kind);

const one = (d: Record<string, any>, kind: string, subject: string): Record<string, any> => {
  const p = ofKind(d, kind).find((x) => x.subject === subject);
  if (!p) throw new Error(`no ${kind} proposal for ${subject}`);
  return p;
};

describe("lint_wiki conventions", () => {
  it("a note missing a required property gets a conventions proposal with missing_required and no tool_args", async () => {
    const d = await lint(fixture(), { checks: ["conventions"] });
    const p = one(d, "conventions", "wiki/NoType.md");
    expect(p).toBeDefined();
    expect(p.evidence.warnings).toEqual([
      expect.objectContaining({ code: "missing_required", property: "type" }),
    ]);
    expect(p.tool_args).toBeUndefined();
    expect(p.tool).toBe("update_frontmatter");
  });

  it("a disallowed tag gets a proposal whose tool_args remove that tag from the frontmatter", async () => {
    const d = await lint(fixture(), { checks: ["conventions"] });
    const p = one(d, "conventions", "wiki/BadTag.md");
    expect(p.tool).toBe("remove_tag");
    expect(p.tool_args).toEqual({
      vault: "test",
      path: "wiki/BadTag.md",
      tag: "nope",
      location: "frontmatter",
    });
  });

  it("a scalar with one allowed value gets update_frontmatter set to it; several allowed values get no tool_args", async () => {
    const d = await lint(fixture(), { checks: ["conventions"] });
    const status = one(d, "conventions", "wiki/BadStatus.md");
    expect(status.tool).toBe("update_frontmatter");
    expect(status.tool_args).toEqual({
      vault: "test",
      path: "wiki/BadStatus.md",
      operation: "set",
      key: "status",
      value: "draft",
    });
    const kind = one(d, "conventions", "wiki/BadKind.md");
    expect(kind.tool_args).toBeUndefined();
  });

  it("a clean vault and a vault with no SCHEMA.md get no conventions proposals, and the existing kinds are unchanged", async () => {
    const clean = fixture({ "wiki/Good.md": FILES["wiki/Good.md"] as string });
    const d = await lint(clean, { checks: ["conventions", "conventions_file"] });
    expect(d.proposals).toEqual([]);

    const bare = fixture({ "wiki/NoType.md": FILES["wiki/NoType.md"] as string });
    const withNew = await lint(bare, {});
    const before = await lint(bare, { checks: [...LEGACY_CHECKS] });
    expect(
      withNew.proposals.filter((p: { kind: string }) => !p.kind.startsWith("conventions")),
    ).toEqual(before.proposals);
    expect(ofKind(withNew, "conventions")).toEqual([]);
  });

  it("a broken SCHEMA.md gives one conventions_file proposal for that layer", async () => {
    const d = await lint(fixture({ ...FILES, "wiki/SCHEMA.md": layer("  version: [unclosed") }), {
      checks: ["conventions_file"],
    });
    const files = ofKind(d, "conventions_file");
    expect(files).toHaveLength(1);
    expect(files[0]?.subject).toBe("wiki/SCHEMA.md");
    expect(files[0]?.tool).toBe("read_note");
  });

  it("a layer the caller cannot read gives no proposals from it and no conventions_file, while a caller who can read it gets both", async () => {
    const files = {
      "SCHEMA.md": layer("  version: 1\n  frontmatter:\n    required: [owner]"),
      "wiki/SCHEMA.md": "---\nconventions: [unclosed\n---\n",
      "wiki/Note.md": "---\ntype: research\n---\nno owner\n",
    };
    const reader = await lint(fixture(files, { readPaths: ["**"] }), {
      checks: ["conventions", "conventions_file"],
    });
    expect(ofKind(reader, "conventions_file").map((p) => p.subject)).toEqual(["wiki/SCHEMA.md"]);
    expect(ofKind(reader, "conventions").map((p) => p.subject)).toEqual(["wiki/Note.md"]);

    const limited = await lint(fixture(files, { readPaths: ["wiki/**"] }), {
      checks: ["conventions", "conventions_file"],
    });
    // The root layer is unreadable to this caller: no rule from it, and no report of it. The wiki
    // layer is readable, so its own file warning still stands.
    expect(ofKind(limited, "conventions")).toEqual([]);
    expect(ofKind(limited, "conventions_file").map((p) => p.subject)).toEqual(["wiki/SCHEMA.md"]);
  });

  it("checks: ['conventions'] runs only that kind", async () => {
    const d = await lint(fixture(), { checks: ["conventions"] });
    expect(d.checks_run).toEqual(["conventions"]);
    expect(d.proposals.length).toBeGreaterThan(0);
    for (const p of d.proposals) expect(p.kind).toBe("conventions");
  });

  it("the default check set includes both new kinds, as it includes every existing kind", async () => {
    const d = await lint(fixture(), {});
    expect(d.checks_run).toEqual(expect.arrayContaining(["conventions", "conventions_file"]));
    expect(d.skipped.map((s: { check: string }) => s.check)).not.toContain("conventions");
    expect(d.skipped.map((s: { check: string }) => s.check)).not.toContain("conventions_file");
  });

  it("generated wiki index/log pages and raw notes are never reported", async () => {
    h = makeWikiHarness({
      files: {
        "wiki/SCHEMA.md": RULES,
        "wiki/index.md": "---\ntitle: index\n---\nno type\n",
        "wiki/log.md": "---\ntitle: log\n---\nno type\n",
        "raw/Source.md": "---\nstatus: draft\n---\nraw, no type\n",
        "wiki/Page.md": "---\nstatus: draft\n---\nno type\n",
      },
      wikiFolder: "wiki",
      rawFolder: "raw",
      acl: { readPaths: ["wiki/**", "raw/**"] },
    });
    const d = await lint(h, { checks: ["conventions"] });
    expect(ofKind(d, "conventions").map((p) => p.subject)).toEqual(["wiki/Page.md"]);
  });

  it("an abort between two steps of the scan stops it early", async () => {
    const hh = fixture();
    const ctx = hh.v.ctx();
    const scope = {
      vaultId: "test",
      root: hh.v.root,
      acl: ctx.acl,
      grantedScopes: ctx.grantedScopes,
    };
    const ac = new AbortController();
    let steps = 0;
    let finished = false;
    function* tapped() {
      const g = conventionsScanSteps(scope, () => true);
      for (let r = g.next(); ; r = g.next()) {
        if (r.done) {
          finished = true;
          return r.value;
        }
        steps += 1;
        if (steps === 2) ac.abort();
        yield;
      }
    }
    await expect(drainYielding(tapped(), ac.signal, 0)).rejects.toThrow();
    expect(finished).toBe(false);
    expect(steps).toBe(2);
  });
});
