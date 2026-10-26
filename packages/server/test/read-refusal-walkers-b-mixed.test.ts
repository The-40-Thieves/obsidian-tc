// Platform-independent twin of read-refusal-walkers-b.test.ts: the safe open's refusal is simulated by
// throwing acl_denied from readNote for one note (b.md), so the skip-and-count path runs on every OS.
// A separate file: the readNote mock must not reach any other test's module graph.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestVault } from "./m1-helpers";
import { okData } from "./read-refusal-helpers";
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

describe("a refused read is skipped and counted, not fatal (PR B walkers)", () => {
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
