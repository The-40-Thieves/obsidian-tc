// Platform-independent twin of read-refusal-walkers-b.test.ts: the safe open's refusal is simulated by
// throwing acl_denied from readNote for one note (b.md), so the skip-and-count path runs on every OS.
// A separate file: the readNote mock must not reach any other test's module graph.
import { err, type ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestVault } from "./m1-helpers";
import { makeM4Vault } from "./m4-helpers";
import { expectLintScansRan, okData } from "./read-refusal-helpers";
import { makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

vi.mock("../src/vault/notes-io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault/notes-io")>();
  return {
    ...actual,
    readNote: (abs: string) => {
      if (abs.endsWith("b.md"))
        throw err.aclDenied("safe open refused the path: test", { path: abs });
      return actual.readNote(abs);
    },
  };
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const FILES = {
  "a.md": "---\nstatus: open\ntags: [alpha]\n---\n# A\n#alpha [[a]]\n",
  "b.md": "# B\n",
};

describe("a refused read is skipped and counted, not fatal", () => {
  it("get_backlinks skips the refused note, counts it, and never names it", async () => {
    const v = makeTestVault({ files: { "a.md": "# A\n", "c.md": "[[a]]\n", "b.md": "[[a]]\n" } });
    cleanups.push(() => v.cleanup());
    const d = okData(await v.call("get_backlinks", { vault: "test", path: "a.md" }));
    expect(JSON.stringify(d)).toContain("c.md");
    expect(JSON.stringify(d)).not.toContain("b.md");
    expect(d.notes_read_refused).toBe(1);
  });

  it("list_tags (disk leg) skips the refused note and counts it", async () => {
    const v = makeTestVault({ files: { "a.md": "#alpha\n", "b.md": "#beta\n" } });
    cleanups.push(() => v.cleanup());
    const d = okData(await v.call("list_tags", { vault: "test" }));
    expect(d.tags).toEqual([{ tag: "alpha", count: 1 }]);
    expect(d.notes_read_refused).toBe(1);
  });

  it("lint_wiki reads the refused note in its link and provenance scans and counts it once", async () => {
    const h: WikiHarness = makeWikiHarness({
      files: { "a.md": "[[x]]\n", "b.md": "[[a]]\n" },
    });
    cleanups.push(() => h.v.cleanup());
    const lint = await h.data("lint_wiki", {});
    expect(lint.notes_read_refused).toBe(1);
    expectLintScansRan(lint);
  });

  it("a refused note the caller may not read is neither read nor counted", async () => {
    const v = makeTestVault({
      files: { "pub/a.md": "#alpha\n", "private/b.md": "#secret\n" },
      acl: { rules: [{ glob: "private/**", scopes: ["read:private"] }] },
    });
    cleanups.push(() => v.cleanup());
    const d = okData(
      await v.call("list_tags", { vault: "test" }, { grantedScopes: new Set(["read:notes"]) }),
    );
    expect(d.tags).toEqual([{ tag: "alpha", count: 1 }]);
    expect(d).not.toHaveProperty("notes_read_refused");
  });
});

/** Each walker that reads every note, with input that takes the walk over `a.md` and `b.md`. */
const WALKERS: Array<{ tool: string; input: Record<string, unknown>; concise: boolean }> = [
  { tool: "find_unresolved_links", input: {}, concise: true },
  { tool: "find_notes_by_tag", input: { tag: "alpha" }, concise: true },
  { tool: "list_properties", input: {}, concise: false },
  { tool: "suggest_tags", input: { path: "a.md" }, concise: true },
  { tool: "vault_health_score", input: {}, concise: true },
  { tool: "find_link_cycles", input: {}, concise: false },
  { tool: "get_link_strength", input: { from: "a.md", to: "a.md" }, concise: false },
  { tool: "suggest_links", input: { path: "a.md" }, concise: true },
];

const CASES = WALKERS.flatMap(({ tool, input, concise }) =>
  (concise ? [undefined, "concise"] : [undefined]).map((response_format) => ({
    tool,
    input,
    response_format,
  })),
);

describe("every walker reports the refused note in its detailed and concise output", () => {
  it.each(CASES)(
    "$tool (response_format $response_format) counts the refused note",
    async ({ tool, input, response_format }) => {
      const v = makeTestVault({ files: FILES });
      cleanups.push(() => v.cleanup());
      const d = okData(
        await v.call(tool, {
          vault: "test",
          ...input,
          ...(response_format ? { response_format } : {}),
        }),
      );
      expect(d.notes_read_refused).toBe(1);
    },
  );

  it.each([undefined, "concise"] as const)(
    "bundle_folder (response_format %s) counts the refused note",
    async (response_format) => {
      const v = makeM4Vault({
        files: { "Notes/a.md": FILES["a.md"], "Notes/b.md": FILES["b.md"] },
      });
      cleanups.push(() => v.cleanup());
      const r: ToolResult = await v.call("bundle_folder", {
        vault: "test",
        root: "Notes",
        ...(response_format ? { response_format } : {}),
      });
      expect(okData(r).notes_read_refused).toBe(1);
    },
  );

  it("commit_wiki_page counts the refused note its duplicate check reads", async () => {
    const h = makeWikiHarness({
      wikiFolder: "wiki",
      files: { "wiki/a.md": "# A\n", "wiki/b.md": "# B\n" },
    });
    cleanups.push(() => h.v.cleanup());
    const d = await h.data("commit_wiki_page", {
      topic: "Learning techniques",
      type: "concept",
      sources: [],
      page: {
        path: "wiki/Learning techniques.md",
        frontmatter: { type: "concept" },
        body: "# Learning techniques\n",
      },
      patches: [],
    });
    expect(d.notes_read_refused).toBe(1);
  });
});
