// lint_wiki's `conventions` and `conventions_file` kinds: the SCHEMA.md folder conventions a note breaks
// (one proposal per note, tool_args only for an unambiguous fix) and the layers with file warnings (one
// proposal per layer). Both are caller-scoped, skip the generated wiki pages and raw notes, and leave the
// existing kinds' output as it was.
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("a tag remove_tag refuses gets no tool_args; a valid tag, mixed case included, is fixed by its proposal and the next lint is clean", async () => {
    const hh = fixture({
      "wiki/SCHEMA.md": RULES,
      "wiki/MixedCase.md": '---\ntype: research\ntags: [project, "#NoPe"]\n---\nx\n',
      "wiki/Numeric.md": '---\ntype: research\ntags: [project, "2024"]\n---\nx\n',
      "wiki/Unicode.md": "---\ntype: research\ntags: [project, über]\n---\nx\n",
      "wiki/Spaced.md": '---\ntype: research\ntags: [project, "my tag"]\n---\nx\n',
    });
    const d = await lint(hh, { checks: ["conventions"] });
    for (const subject of ["wiki/Numeric.md", "wiki/Unicode.md", "wiki/Spaced.md"]) {
      expect(one(d, "conventions", subject).tool_args).toBeUndefined();
    }
    const mixed = one(d, "conventions", "wiki/MixedCase.md");
    expect(mixed.tool_args).toEqual({
      vault: "test",
      path: "wiki/MixedCase.md",
      tag: "NoPe",
      location: "frontmatter",
    });
    expect((await hh.call(mixed.tool, mixed.tool_args)).ok).toBe(true);
    const after = await lint(hh, { checks: ["conventions"] });
    expect(ofKind(after, "conventions").map((p) => p.subject)).not.toContain("wiki/MixedCase.md");
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

  it("a value that is not a string (boolean, number, list) gets no update_frontmatter tool_args, so the fix keeps the property's type", async () => {
    const hh = fixture({
      "wiki/SCHEMA.md": layer(
        "  frontmatter:\n    values:\n      status: [draft]\n      published: [true]\n      prio: [1]\n      cats: [a]",
      ),
      "wiki/Stale.md": "---\nstatus: stale\n---\nx\n",
      "wiki/Checkbox.md": "---\npublished: false\n---\nx\n",
      "wiki/Number.md": "---\nprio: 2\n---\nx\n",
      "wiki/List.md": "---\ncats: [a, z]\n---\nx\n",
    });
    const d = await lint(hh, { checks: ["conventions"] });
    for (const subject of ["wiki/Checkbox.md", "wiki/Number.md", "wiki/List.md"]) {
      expect(one(d, "conventions", subject).tool_args).toBeUndefined();
    }
    const stale = one(d, "conventions", "wiki/Stale.md");
    expect(stale.tool_args).toEqual({
      vault: "test",
      path: "wiki/Stale.md",
      operation: "set",
      key: "status",
      value: "draft",
    });
    expect((await hh.call(stale.tool, stale.tool_args)).ok).toBe(true);
    const after = await lint(hh, { checks: ["conventions"] });
    expect(ofKind(after, "conventions").map((p) => p.subject)).not.toContain("wiki/Stale.md");
    expect(readFileSync(join(hh.v.root, "wiki/Stale.md"), "utf8")).toMatch(/^status: draft$/m);
  });

  it("a note that breaks a block rule is proposed first, its detail counts the blocking violations, and a warn-only proposal keeps its text", async () => {
    const hh = fixture({
      "wiki/SCHEMA.md": layer(
        "  version: 1\n  frontmatter:\n    required: [type]\n    values:\n      status: [draft]\n      kind: [a, b]\n    severity:\n      status: block",
      ),
      // Zed sorts after Alpha: scan order alone would put the warn-only proposal first.
      "wiki/Zed.md": "---\ntype: research\nstatus: stale\nkind: z\n---\nblocking\n",
      "wiki/Alpha.md": "---\ntype: research\nkind: z\n---\nwarn only\n",
    });
    const d = await lint(hh, { checks: ["conventions"] });
    const ps = ofKind(d, "conventions");
    expect(ps.map((p) => p.subject)).toEqual(["wiki/Zed.md", "wiki/Alpha.md"]);
    const zed = ps[0] as Record<string, any>;
    expect(zed.detail).toMatch(/^2 folder convention\(s\) broken \(1 blocking\): /);
    expect(zed.suggested_action).toMatch(/are refused until this note is fixed/);
    expect(zed.evidence.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: "status", level: "block" }),
        expect.objectContaining({ property: "kind", level: "warn" }),
      ]),
    );
    expect(ps[1]).toEqual(
      expect.objectContaining({
        detail: '1 folder convention(s) broken: `kind` has "z"; allowed: a, b',
        suggested_action:
          "Fix the frontmatter to match the folder's conventions (get_conventions lists them), then re-run lint_wiki.",
      }),
    );
  });

  it("a child's severity '*' does not relax a parent's named type-level block", async () => {
    const hh = fixture({
      "wiki/SCHEMA.md": layer(
        "  version: 1\n  frontmatter:\n    types:\n      meeting:\n        required: [date]\n        severity:\n          date: block",
      ),
      "wiki/meetings/SCHEMA.md": layer(
        '  version: 1\n  frontmatter:\n    severity:\n      "*": warn',
      ),
      "wiki/meetings/Standup.md": "---\ntype: meeting\n---\nno date\n",
    });
    const d = await lint(hh, { checks: ["conventions"] });
    expect(one(d, "conventions", "wiki/meetings/Standup.md").evidence.warnings).toEqual([
      expect.objectContaining({ code: "missing_required", property: "date", level: "block" }),
    ]);
  });

  it("a child's null on the parent's type-level leaf removes the block, so the child's '*' applies", async () => {
    const hh = fixture({
      "wiki/SCHEMA.md": layer(
        "  version: 1\n  frontmatter:\n    types:\n      meeting:\n        required: [date]\n        severity:\n          date: block",
      ),
      "wiki/meetings/SCHEMA.md": layer(
        '  version: 1\n  frontmatter:\n    severity:\n      "*": warn\n    types:\n      meeting:\n        severity:\n          date: null',
      ),
      "wiki/meetings/Standup.md": "---\ntype: meeting\n---\nno date\n",
    });
    const d = await lint(hh, { checks: ["conventions"] });
    expect(one(d, "conventions", "wiki/meetings/Standup.md").evidence.warnings).toEqual([
      expect.objectContaining({ code: "missing_required", property: "date", level: "warn" }),
    ]);
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

  it("a layer the caller cannot read gives no conventions_file and no rules from it, while a caller who can read it gets the report", async () => {
    const files = {
      "SCHEMA.md": "---\nconventions: [unclosed\n---\n",
      "wiki/SCHEMA.md": layer("  version: 1\n  frontmatter:\n    required: [owner]"),
      "wiki/Note.md": "---\ntype: research\n---\nno owner\n",
    };
    const reader = await lint(fixture(files, { readPaths: ["**"] }), {
      checks: ["conventions", "conventions_file"],
    });
    expect(ofKind(reader, "conventions_file").map((p) => p.subject)).toEqual(["SCHEMA.md"]);
    expect(ofKind(reader, "conventions").map((p) => p.subject)).toEqual(["wiki/Note.md"]);

    const limited = await lint(fixture(files, { readPaths: ["wiki/**"] }), {
      checks: ["conventions", "conventions_file"],
    });
    // The root layer is unreadable to this caller: its warning is not reported. The wiki layer is
    // readable, so its rule still applies to the note it sits over.
    expect(ofKind(limited, "conventions_file")).toEqual([]);
    expect(ofKind(limited, "conventions").map((p) => p.subject)).toEqual(["wiki/Note.md"]);
  });

  it("with folder set, a broken SCHEMA.md above that folder is not reported, one inside it is", async () => {
    const files = {
      "SCHEMA.md": "---\nconventions: [unclosed\n---\n",
      "proj/SCHEMA.md": "---\nconventions: [unclosed\n---\n",
      "proj/sub/SCHEMA.md": layer("  version: 1\n  frontmatter:\n    required: [owner]"),
      "proj/sub/Note.md": "---\ntype: research\n---\nno owner\n",
    };
    const input = { checks: ["conventions", "conventions_file"], folder: "proj/sub" };
    const scoped = await lint(fixture(files, { readPaths: ["**"] }), input);
    expect(ofKind(scoped, "conventions_file")).toEqual([]);
    expect(ofKind(scoped, "conventions").map((p) => p.subject)).toEqual(["proj/sub/Note.md"]);

    const inside = await lint(
      fixture(
        { ...files, "proj/sub/SCHEMA.md": "---\nconventions: [unclosed\n---\n" },
        {
          readPaths: ["**"],
        },
      ),
      input,
    );
    expect(ofKind(inside, "conventions_file").map((p) => p.subject)).toEqual([
      "proj/sub/SCHEMA.md",
    ]);
  });

  it("a scan that drops file warnings past the cap says how many on each conventions_file proposal", async () => {
    // 52 broken layers on one chain (root plus 51 folders): one warning each, the cap keeps 50.
    const depth = 51;
    const files: Record<string, string> = {};
    let dir = "";
    for (let i = 0; i <= depth; i++) {
      files[`${dir}SCHEMA.md`] = "---\nconventions: [unclosed\n---\n";
      dir = `${dir}d${i}/`;
    }
    files[`${dir}Note.md`] = "---\ntype: research\n---\nx\n";
    const d = await lint(fixture(files, { readPaths: ["**"] }), {
      checks: ["conventions_file"],
      limit_per_check: 100,
    });
    const layers = ofKind(d, "conventions_file");
    expect(layers).toHaveLength(50);
    expect(layers.map((p) => p.evidence.file_warnings_omitted)).toEqual(
      layers.map(() => depth + 1 - 50),
    );
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

  it("an abort between two notes of one folder stops the scan inside the per-note loop", async () => {
    const hh = fixture({
      "wiki/SCHEMA.md": RULES,
      "wiki/N1.md": "x\n",
      "wiki/N2.md": "x\n",
      "wiki/N3.md": "x\n",
      "wiki/N4.md": "x\n",
      "wiki/N5.md": "x\n",
    });
    const ctx = hh.v.ctx();
    const scope = {
      vaultId: "test",
      root: hh.v.root,
      acl: ctx.acl,
      grantedScopes: ctx.grantedScopes,
    };
    const ac = new AbortController();
    const judged: string[] = [];
    // keep() runs once per note of the walk, after that note's step: aborting on the second one lands
    // the abort inside the per-note loop, with four notes still to go.
    const keep = (p: string): boolean => {
      judged.push(p);
      if (judged.length === 2) ac.abort();
      return true;
    };
    let finished = false;
    function* tapped() {
      const r = yield* conventionsScanSteps(scope, keep);
      finished = true;
      return r;
    }
    await expect(drainYielding(tapped(), ac.signal, 0)).rejects.toThrow();
    expect(finished).toBe(false);
    expect(judged).toHaveLength(2);
  });

  it("a legacy-only wiki SCHEMA.md is not hinted at inside the configured wiki folder", async () => {
    const hh = makeWikiHarness({
      files: {
        "wiki/SCHEMA.md": "---\ntypes:\n  research: {}\n---\n# legacy\n",
        "wiki/Note.md": "---\ntype: research\n---\nx\n",
      },
      wikiFolder: "wiki",
      acl: { readPaths: ["wiki/**"] },
    });
    const d = await lint(hh, { checks: ["conventions_file"] });
    expect(ofKind(d, "conventions_file")).toEqual([]);
  });
});
