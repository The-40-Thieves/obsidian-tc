// The folder conventions check on the bulk, capture, template and wiki write tools. Each reports a
// `missing_required` warning for every note it wrote that breaks the SCHEMA.md layer, a move reports
// at its destination, a clean write carries no `conventions` key, and the write stands either way:
// the check is advisory.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { registerM6Tools } from "../src/tools/m6";
import { contentHash } from "../src/vault/paths";
import { makeM4Vault } from "./m4-helpers";
import { makeM5Vault } from "./m5-helpers";
import { makeM6Vault } from "./m6-helpers";
import { makeWikiHarness } from "./wiki-test-helpers";

const REQUIRE_TYPE = "---\nconventions:\n  frontmatter:\n    required: [type]\n---\n# rules\n";
const TYPED = "---\ntype: meeting\n---\nbody\n";

interface Warning {
  path: string;
  code: string;
  source: string;
}
interface Conventions {
  warnings?: Warning[];
  warnings_omitted?: number;
}

/** The `conventions` field of a successful call; a failed call is a test failure. */
function conventionsOf(r: ToolResult): Conventions | undefined {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return (r.data as { conventions?: Conventions }).conventions;
}
const pathsOf = (c: Conventions | undefined): string[] | undefined =>
  c?.warnings?.map((w) => w.path);
const hasNoConventionsKey = (r: ToolResult): boolean =>
  r.ok && !("conventions" in (r.data as object));

const made: { cleanup(): void }[] = [];
const track = <T extends { cleanup(): void }>(v: T): T => {
  made.push(v);
  return v;
};
afterEach(() => {
  for (const v of made.splice(0)) v.cleanup();
});

function bulkVault(files: Record<string, string> = {}) {
  return track(
    makeM6Vault({
      conventions: true,
      files: { "meetings/SCHEMA.md": REQUIRE_TYPE, ...files },
      register: (reg, deps) =>
        registerM6Tools(reg, {
          ...deps,
          toolSurface: () => ({ config: reg.visibilityConfig(), tools: reg.list() }),
        }),
    }),
  );
}

describe("bulk_create_notes conventions", () => {
  it("reports missing_required for each written note that breaks the layer, and the writes stand", async () => {
    const v = bulkVault();
    const r = await v.callConfirmed("bulk_create_notes", {
      vault: "test",
      items: [
        { path: "meetings/a.md", content: "x\n", mode: "create" },
        { path: "meetings/b.md", content: TYPED, mode: "create" },
        { path: "meetings/c.md", content: "y\n", mode: "create" },
      ],
    });
    expect(pathsOf(conventionsOf(r))).toEqual(["meetings/a.md", "meetings/c.md"]);
    expect(conventionsOf(r)?.warnings?.[0]?.code).toBe("missing_required");
    expect(v.read("meetings/a.md")).toBe("x\n");
    expect(v.read("meetings/c.md")).toBe("y\n");
  });

  it("a clean write carries no conventions key", async () => {
    const v = bulkVault();
    const r = await v.callConfirmed("bulk_create_notes", {
      vault: "test",
      items: [{ path: "meetings/b.md", content: TYPED, mode: "create" }],
    });
    expect(hasNoConventionsKey(r)).toBe(true);
  });

  it("a bulk write past the warning cap reports 50 warnings and warnings_omitted", async () => {
    const v = bulkVault();
    const items = Array.from({ length: 60 }, (_, i) => ({
      path: `meetings/n${i}.md`,
      content: "x\n",
      mode: "create" as const,
    }));
    const r = await v.callConfirmed("bulk_create_notes", { vault: "test", items });
    const c = conventionsOf(r);
    expect(c?.warnings).toHaveLength(50);
    expect(c?.warnings_omitted).toBe(10);
  });
});

describe("bulk_set_property conventions", () => {
  it("warns on a note still missing its type after an unrelated property is set", async () => {
    const v = bulkVault({ "meetings/a.md": "x\n" });
    const r = await v.callConfirmed("bulk_set_property", {
      vault: "test",
      paths: ["meetings/a.md"],
      key: "status",
      value: "open",
    });
    expect(pathsOf(conventionsOf(r))).toEqual(["meetings/a.md"]);
  });

  it("clean write carries no conventions key: the set fixes the missing type", async () => {
    const v = bulkVault({ "meetings/a.md": "x\n" });
    const r = await v.callConfirmed("bulk_set_property", {
      vault: "test",
      paths: ["meetings/a.md"],
      key: "type",
      value: "meeting",
    });
    expect(hasNoConventionsKey(r)).toBe(true);
  });
});

describe("bulk_move_notes conventions", () => {
  it("reports the convention warning at the destination path", async () => {
    const v = bulkVault({ "notes/x.md": "x\n" });
    const r = await v.callConfirmed("bulk_move_notes", {
      vault: "test",
      moves: [{ from: "notes/x.md", to: "meetings/x.md" }],
      dry_run: false,
    });
    expect(pathsOf(conventionsOf(r))).toEqual(["meetings/x.md"]);
    expect(v.exists("notes/x.md")).toBe(false);
  });

  it("a clean write carries no conventions key", async () => {
    const v = bulkVault({ "notes/t.md": TYPED });
    const r = await v.callConfirmed("bulk_move_notes", {
      vault: "test",
      moves: [{ from: "notes/t.md", to: "meetings/t.md" }],
      dry_run: false,
    });
    expect(hasNoConventionsKey(r)).toBe(true);
  });
});

describe("commit_capture conventions", () => {
  const captureVault = (files: Record<string, string> = {}) =>
    track(
      makeM5Vault({ conventions: true, files: { "meetings/SCHEMA.md": REQUIRE_TYPE, ...files } }),
    );

  /** Queues one capture, then commits it to meetings/c.md with the given extra arguments. */
  const commitOne = async (extra: Record<string, unknown> = {}): Promise<ToolResult> => {
    const v = captureVault();
    const enq = await v.call("enqueue_capture", {
      vault: "test",
      content: "x\n",
      source: "ambient",
    });
    if (!enq.ok) throw new Error(enq.error.message);
    const captureId = (enq.data as { capture_id: string }).capture_id;
    return v.call("commit_capture", {
      vault: "test",
      capture_id: captureId,
      target_path: "meetings/c.md",
      ...extra,
    });
  };

  it("reports missing_required for the committed note", async () => {
    const r = await commitOne();
    expect(pathsOf(conventionsOf(r))).toEqual(["meetings/c.md"]);
  });

  it("a clean write carries no conventions key", async () => {
    const r = await commitOne({ frontmatter_overrides: { type: "meeting" } });
    expect(hasNoConventionsKey(r)).toBe(true);
  });
});

describe("execute_template conventions", () => {
  // The fake companion plays Templater: it reports `reported` as the created note and, unless
  // `written` is null, writes that content there first (null = the template failed, nothing written).
  const templateVault = (existing: string, reported: string, written: string | null) =>
    track(
      makeM4Vault({
        installed: ["templater"],
        conventions: true,
        files: { "Meetings/SCHEMA.md": REQUIRE_TYPE, "Meetings/t.md": existing },
        routes: {
          "POST /obsidian-tc/v1/templater/execute": {
            body: { ok: true, result: { target: reported, created_at: "t" } },
          },
        },
        onBridge: (i, root) => {
          if (written !== null && i.url.endsWith("/templater/execute"))
            writeFileSync(join(root, reported), written);
        },
      }),
    );
  const input = {
    vault: "test",
    template: "Templates/x.md",
    target: "Meetings/t",
    overwrite: true,
  };

  it("reports missing_required for the note Templater wrote", async () => {
    const v = templateVault(TYPED, "Meetings/t.md", "x\n");
    const r = await v.callConfirmed("execute_template", input);
    expect(pathsOf(conventionsOf(r))).toEqual(["Meetings/t.md"]);
  });

  it("reports at the path Templater renamed the note to", async () => {
    const v = templateVault(TYPED, "Meetings/renamed.md", "x\n");
    const r = await v.callConfirmed("execute_template", input);
    expect(pathsOf(conventionsOf(r))).toEqual(["Meetings/renamed.md"]);
  });

  it("a template that wrote nothing does not judge the untouched note", async () => {
    const v = templateVault("x\n", "Meetings/t.md", null);
    const r = await v.callConfirmed("execute_template", input);
    expect(hasNoConventionsKey(r)).toBe(true);
  });

  it("a clean write carries no conventions key", async () => {
    const v = templateVault("x\n", "Meetings/t.md", TYPED);
    const r = await v.callConfirmed("execute_template", input);
    expect(hasNoConventionsKey(r)).toBe(true);
  });
});

describe("commit_wiki_page conventions", () => {
  const PAGE = "wiki/concepts/Learning techniques.md";
  const MENTIONS = "---\ntype: concept\n---\nNotes\n\nI rely on learning techniques.\n";
  const wikiHarness = () =>
    makeWikiHarness({
      conventions: true,
      centralAcl: true,
      wikiFolder: "wiki",
      files: { "wiki/SCHEMA.md": REQUIRE_TYPE, "wiki/Mentions.md": MENTIONS },
    });
  const commit = (frontmatter: Record<string, unknown>) => ({
    vault: "test",
    topic: "Learning techniques",
    page: { path: PAGE, frontmatter, body: "# Learning techniques\n\nSee [[Mentions]].\n" },
    patches: [
      {
        path: "wiki/Mentions.md",
        prev_hash: contentHash(MENTIONS),
        operation: "link",
      },
    ],
  });

  it("reports missing_required for the new page and not for the patched note that has a type", async () => {
    const h = wikiHarness();
    track(h.v);
    const r = await h.v.call("commit_wiki_page", commit({}));
    expect(pathsOf(conventionsOf(r))).toEqual([PAGE]);
  });

  it("a clean write carries no conventions key", async () => {
    const h = wikiHarness();
    track(h.v);
    const r = await h.v.call("commit_wiki_page", commit({ type: "concept" }));
    expect(hasNoConventionsKey(r)).toBe(true);
  });
});
