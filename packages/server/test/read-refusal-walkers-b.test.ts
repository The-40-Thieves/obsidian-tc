// PR B of the read-refusal walkers: the whole-vault walkers that are not search or attachments skip
// a note the safe open refuses (a hard link to a file outside the vault) and count it in
// notes_read_refused, never name it. The platform-independent twin is read-refusal-walkers-b-mixed.test.ts.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestVault } from "./m1-helpers";
import { makeM3Vault } from "./m3-helpers";
import { makeM4Vault } from "./m4-helpers";
import { hardLinkOutside, okData } from "./read-refusal-helpers";
import { makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const BOARD =
  '---\nkanban-plugin: board\n---\n\n## To Do\n\n- [ ] Task A\n\n%% kanban:settings\n{"kanban-plugin":"board"}\n%%\n';
const BASE = "views:\n  - name: V\n    type: table\n";

/** A note the caller may read, plus the refused hard link (n/hl.md) carrying `text`. */
function linked<T extends { root: string; cleanup(): void }>(v: T, text: string): T {
  cleanups.push(v.cleanup.bind(v));
  cleanups.push(hardLinkOutside(v.root, text));
  return v;
}

describe.skipIf(process.platform === "win32")(
  "walkers skip a hard-linked note and count it",
  () => {
    it("list_tags (disk leg) counts the readable tags and the refusal", async () => {
      const v = linked(
        makeTestVault({ files: { "a.md": "#alpha\n", "n/b.md": "#beta\n" } }),
        "#gamma\n",
      );
      const d = okData(await v.call("list_tags", { vault: "test" }));
      expect(d.tags).toEqual([
        { tag: "alpha", count: 1 },
        { tag: "beta", count: 1 },
      ]);
      expect(d.notes_read_refused).toBe(1);
      expect(JSON.stringify(d)).not.toContain("hl.md");
    });

    it("a hard-linked note the caller may not read is neither read nor counted", async () => {
      const v = makeTestVault({
        files: { "pub/a.md": "#alpha\n", "private/x.md": "#secret\n" },
        acl: { rules: [{ glob: "private/**", scopes: ["read:private"] }] },
      });
      cleanups.push(() => v.cleanup());
      cleanups.push(hardLinkOutside(v.root, "#secret\n", join("private", "hl.md")));
      const d = okData(
        await v.call("list_tags", { vault: "test" }, { grantedScopes: new Set(["read:notes"]) }),
      );
      expect(d.tags).toEqual([{ tag: "alpha", count: 1 }]);
      expect(d).not.toHaveProperty("notes_read_refused");
    });

    it("find_notes_by_property returns the readable matches and the refusal", async () => {
      const v = linked(
        makeTestVault({
          files: { "a.md": "---\nstatus: open\n---\n", "n/b.md": "---\nstatus: open\n---\n" },
        }),
        "---\nstatus: open\n---\n",
      );
      const d = okData(await v.call("find_notes_by_property", { vault: "test", key: "status" }));
      expect((d.matches as Array<{ path: string }>).map((m) => m.path)).toEqual(["a.md", "n/b.md"]);
      expect(d.notes_read_refused).toBe(1);
    });

    it("query_base returns the readable rows and the refusal", async () => {
      const v = linked(
        makeM3Vault({ files: { "p.base": BASE, "a.md": "x\n", "n/b.md": "y\n" } }),
        "z\n",
      );
      const d = okData(await v.call("query_base", { vault: "test", path: "p.base" }));
      expect(d.total).toBe(2);
      expect(d.notes_read_refused).toBe(1);
    });

    it("list_kanban_boards lists the readable boards and the refusal", async () => {
      const v = linked(
        makeM3Vault({ files: { "b.md": BOARD, "plain.md": "# nope\n", "n/x.md": "# x\n" } }),
        BOARD,
      );
      const d = okData(await v.call("list_kanban_boards", { vault: "test" }));
      expect(d.boards).toEqual([expect.objectContaining({ path: "b.md" })]);
      expect(d.notes_read_refused).toBe(1);
    });

    it("bundle_folder bundles the readable notes and counts the refusal", async () => {
      const v = makeM4Vault({ files: { "Notes/a.md": "# A\nalpha\n", "Notes/x.md": "# X\n" } });
      cleanups.push(() => v.cleanup());
      cleanups.push(hardLinkOutside(v.root, "# outside\n", join("Notes", "hl.md")));
      const d = okData(await v.call("bundle_folder", { vault: "test", root: "Notes" }));
      expect((d.files as Array<{ path: string }>).map((f) => f.path)).toEqual([
        "Notes/a.md",
        "Notes/x.md",
      ]);
      expect(d.notes_read_refused).toBe(1);
    });

    it("find_orphans, get_backlinks and audit_provenance skip the refused note", async () => {
      const v = linked(
        makeTestVault({
          files: { "a.md": "# A\n", "n/c.md": "[[a]]\n", "n/d.md": "---\nsources: [s]\n---\n" },
        }),
        "[[a]]\n",
      );
      const orphans = okData(await v.call("find_orphans", { vault: "test" }));
      expect(orphans.notes_read_refused).toBe(1);
      const back = okData(await v.call("get_backlinks", { vault: "test", path: "a.md" }));
      expect(JSON.stringify(back)).toContain("n/c.md");
      expect(back.notes_read_refused).toBe(1);
      const audit = okData(await v.call("audit_provenance", { vault: "test" }));
      expect(audit.scanned).toBe(3);
      expect(audit.notes_read_refused).toBe(1);
    });

    it("lint_wiki, find_existing_page and draft_wiki_page answer, and count the refusal once", async () => {
      const h: WikiHarness = makeWikiHarness({
        files: {
          "wiki/Spaced repetition.md": "# Spaced repetition\n\nReview cards.\n",
          "wiki/Other.md": "[[Spaced repetition]]\n",
        },
      });
      cleanups.push(() => h.v.cleanup());
      cleanups.push(hardLinkOutside(h.v.root, "[[Spaced repetition]]\n", join("wiki", "hl.md")));
      const lint = await h.data("lint_wiki", {});
      expect(lint.notes_read_refused).toBe(1);
      const found = await h.data("find_existing_page", { topic: "Spaced repetition" });
      expect(found.verdict).toBe("exists");
      expect(found.notes_read_refused).toBe(1);
      const draft = await h.data("draft_wiki_page", { topic: "Spaced repetition" });
      expect(draft.notes_read_refused).toBe(1);
    });
  },
);

describe("a clean vault's walks carry no notes_read_refused key", () => {
  it("list_tags and find_orphans", async () => {
    const v = makeTestVault({ files: { "a.md": "#alpha\n", "n/b.md": "[[a]]\n" } });
    cleanups.push(() => v.cleanup());
    expect(okData(await v.call("list_tags", { vault: "test" }))).not.toHaveProperty(
      "notes_read_refused",
    );
    expect(okData(await v.call("find_orphans", { vault: "test" }))).not.toHaveProperty(
      "notes_read_refused",
    );
  });
});

/** The walkers whose output schema must declare notes_read_refused, by the registry that serves them. */
const DECLARES_REFUSALS = {
  m1: [
    "list_tags",
    "suggest_tags",
    "find_notes_by_tag",
    "list_properties",
    "find_notes_by_property",
    "find_orphans",
    "get_backlinks",
    "find_unresolved_links",
    "audit_provenance",
    "vault_health_score",
    "find_link_cycles",
    "get_link_strength",
    "suggest_links",
  ],
  m3: ["query_base", "list_kanban_boards"],
  m4: ["bundle_folder"],
  m7: ["lint_wiki", "find_existing_page", "draft_wiki_page", "commit_wiki_page"],
} as const;

describe("each walker declares notes_read_refused in its output schema", () => {
  function declares(
    registry: { list(): Array<{ name: string; outputSchema: unknown }> },
    name: string,
  ): boolean {
    const def = registry.list().find((d) => d.name === name);
    const shape = (def?.outputSchema as { shape?: object } | undefined)?.shape ?? {};
    return "notes_read_refused" in shape;
  }

  it.each(DECLARES_REFUSALS.m1)("%s (M1 registry)", (name) => {
    const v = makeTestVault();
    cleanups.push(() => v.cleanup());
    expect(declares(v.registry, name)).toBe(true);
  });

  it.each(DECLARES_REFUSALS.m3)("%s (M3 registry)", (name) => {
    const v = makeM3Vault();
    cleanups.push(() => v.cleanup());
    expect(declares(v.registry, name)).toBe(true);
  });

  it.each(DECLARES_REFUSALS.m4)("%s (M4 registry)", (name) => {
    const v = makeM4Vault();
    cleanups.push(() => v.cleanup());
    expect(declares(v.registry, name)).toBe(true);
  });

  it.each(DECLARES_REFUSALS.m7)("%s (M7 registry)", (name) => {
    const h = makeWikiHarness();
    cleanups.push(() => h.v.cleanup());
    expect(declares(h.v.registry, name)).toBe(true);
  });
});
