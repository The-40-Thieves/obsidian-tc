// lint_wiki `cycles` check: link loops of three or more notes become `link_cycle` proposals, under
// the same scope rules as the other checks (read ACL, Excluded files, folder).
import { afterEach, describe, expect, it } from "vitest";
import { makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

type Proposal = {
  kind: string;
  subject: string;
  related?: string[];
  detail?: string;
  suggested_action: string;
  tool: string;
  tool_args?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
};

const note = (...links: string[]): string =>
  `---\nsources: [x]\n---\n${links.map((l) => `[[${l}]]`).join(" ")}\n`;

// One three-note loop (Ring A -> Ring B -> Ring C -> Ring A) and one two-note pair.
const FILES: Record<string, string> = {
  "loops/Ring A.md": note("Ring B"),
  "loops/Ring B.md": note("Ring C"),
  "loops/Ring C.md": note("Ring A"),
  "loops/Pair One.md": note("Pair Two"),
  "loops/Pair Two.md": note("Pair One"),
};

let h: WikiHarness;
afterEach(() => h?.v.cleanup());

const harness = (files: Record<string, string>, readPaths = ["**"]): WikiHarness => {
  h = makeWikiHarness({ files, acl: { readPaths } });
  return h;
};
const cycles = async (hh: WikiHarness, input: Record<string, unknown> = {}): Promise<Proposal[]> =>
  ((await hh.data("lint_wiki", { checks: ["cycles"], ...input })).proposals as Proposal[]).filter(
    (p) => p.kind === "link_cycle",
  );
const members = (p: Proposal): string[] => [p.subject, ...(p.related ?? [])].sort();

describe("lint_wiki: cycles", () => {
  it("proposes one fix per loop of three or more notes, and skips a two-note pair", async () => {
    const hh = harness(FILES);
    const d = await hh.data("lint_wiki", { checks: ["cycles"] });
    expect(d.checks_run).toEqual(["cycles"]);
    const found = (d.proposals as Proposal[]).filter((p) => p.kind === "link_cycle");
    expect(found).toHaveLength(1);
    const p = found[0] as Proposal;
    expect(members(p)).toEqual(["loops/Ring A.md", "loops/Ring B.md", "loops/Ring C.md"]);
    expect(p.tool).toBe("read_notes");
    expect([...((p.tool_args?.paths as string[] | undefined) ?? [])].sort()).toEqual(members(p));
    expect(p.evidence).toMatchObject({ length: 3 });
    expect(p.detail).toContain("->");
    expect(p.suggested_action.length).toBeGreaterThan(10);
    expect(new Set(hh.v.registry.list().map((t) => t.name)).has(p.tool)).toBe(true);
    expect(d.summary.by_kind).toEqual({ link_cycle: 1 });
  });

  it("runs by default, with the other checks", async () => {
    const d = await harness(FILES).data("lint_wiki", {});
    expect(d.checks_run).toContain("cycles");
    expect((d.proposals as Proposal[]).filter((p) => p.kind === "link_cycle")).toHaveLength(1);
  });

  it("folder keeps only loops whose every note is inside it", async () => {
    const hh = harness({
      ...FILES,
      "loops/Out A.md": note("Out B"),
      "other/Out B.md": note("Out C"),
      "loops/Out C.md": note("Out A"),
    });
    expect((await cycles(hh)).length).toBe(2);
    const scoped = await cycles(hh, { folder: "loops" });
    expect(scoped.map(members)).toEqual([
      ["loops/Ring A.md", "loops/Ring B.md", "loops/Ring C.md"],
    ]);
  });

  it("does not report a loop through a note hidden by Obsidian's Excluded files", async () => {
    const hh = harness({
      "loops/Seen A.md": note("Hidden B"),
      "hidden/Hidden B.md": note("Seen C"),
      "loops/Seen C.md": note("Seen A"),
      ".obsidian/app.json": JSON.stringify({ userIgnoreFilters: ["hidden/"] }),
    });
    expect(await cycles(hh)).toEqual([]);
  });

  it("does not report or reveal a loop through a note the caller cannot read", async () => {
    const hh = harness(
      {
        "loops/Open A.md": note("Secret B"),
        "private/Secret B.md": note("Open C"),
        "loops/Open C.md": note("Open A"),
      },
      ["loops/**"],
    );
    const d = await hh.data("lint_wiki", { checks: ["cycles"] });
    expect((d.proposals as Proposal[]).filter((p) => p.kind === "link_cycle")).toEqual([]);
    expect(JSON.stringify(d)).not.toContain("private/");
  });

  it("caps proposals at limit_per_check and says the kind was truncated", async () => {
    const hh = harness({
      ...FILES,
      "more/Loop X.md": note("Loop Y"),
      "more/Loop Y.md": note("Loop Z"),
      "more/Loop Z.md": note("Loop X"),
    });
    const d = await hh.data("lint_wiki", { checks: ["cycles"], limit_per_check: 1 });
    expect((d.proposals as Proposal[]).filter((p) => p.kind === "link_cycle")).toHaveLength(1);
    expect(d.truncated).toEqual(["link_cycle"]);
  });
});
