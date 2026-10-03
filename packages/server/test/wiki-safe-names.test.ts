// A caller-chosen NAME is spliced into `[[...]]` / `![[...]]` bodies of every note that links the
// target (move_note / bulk_move_notes / move_attachment backlink rewrite, rewrite_link's
// to_target), so a destination such as "foo]]\nInjected text" used to close the wikilink early and
// write body text into EVERY linking note — read-denied ones included (the rewrite is the
// vault-wide graph-integrity carve-out), with no confirmation for a same-folder rename.
//
// Two layers, both under test:
//  (a) a NEW destination name that cannot live inside a wikilink is refused with invalid_input
//      (the one shared check next to windowsNameProblem; Obsidian's own link rule: a name with
//      `# | ^ : %% [[ ]]` "may not work as a link"). Existing files with such names stay readable
//      and updatable: only creating the name is refused.
//  (b) rewriteLinks re-parses each link it changed and refuses the note's edit unless the result
//      is exactly the one intended link — so rewrite_link's free-text to_target is covered too.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ToolResult, wikiLinkNameProblem } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { buildBulkTools } from "../src/tools/m6/bulk-tools";
import { rewriteLinks } from "../src/vault/rewrite";
import { makeTestVault, type TestVault } from "./m1-helpers";
import { makeM3Vault } from "./m3-helpers";
import { makeM6Vault } from "./m6-helpers";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

// [label, new base name (no extension)]. Every one holds a char Obsidian says cannot be in a link.
const HOSTILE: Array<[string, string]> = [
  ["close-and-inject", "foo]]\nInjected"],
  ["alias pipe", "a|b"],
  ["open bracket", "a[[b"],
  ["lone close bracket", "a]b"],
  ["heading hash", "a#b"],
  ["block caret", "a^b"],
  ["comment percent pair", "a%%b"],
  ["tab", "a\tb"],
  ["carriage return", "a\rb"],
  ["DEL", "a\u007fb"],
];

const LINKER = "See [[Old]] and ![[Old|pic]] and [m](Old.md) here.\n";

function expectRefused(r: ToolResult): void {
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_input");
}

describe("wikiLinkNameProblem", () => {
  it.each([
    ["a]b", ["]"]],
    ["a|b#c^d[e", ["|", "#", "^", "["]],
    ["x\ny", ["newline"]],
    ["x\u0000y", ["control character"]],
    ["x\u007fy", ["control character"]],
    ["x%%y", ["%%"]],
  ])("%j", (name, chars) => {
    expect(wikiLinkNameProblem(name)).toEqual(chars);
  });
  it.each(["Plain name", "Meeting 2026-10-02", "café ☕ 日本", "a (b) {c} 100% done", "x.y.z"])(
    "admits %j",
    (name) => {
      expect(wikiLinkNameProblem(name)).toBeNull();
    },
  );
});

describe("move_note refuses a destination that cannot live inside a wikilink", () => {
  let v: TestVault | undefined;
  afterEach(() => v?.cleanup());

  it.each(HOSTILE)("%s", async (_l, name) => {
    v = makeTestVault({ files: { "Old.md": "body", "linker.md": LINKER }, centralAcl: true });
    const r = await v.call("move_note", { vault: "test", from: "Old.md", to: `${name}.md` });
    expectRefused(r);
    expect(v.read("linker.md")).toBe(LINKER);
    expect(v.read("Old.md")).toBe("body");
  });

  it("names the offending characters", async () => {
    v = makeTestVault({ files: { "Old.md": "body", "linker.md": LINKER }, centralAcl: true });
    const r = await v.call("move_note", { vault: "test", from: "Old.md", to: "foo]]\nx.md" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("invalid_input");
      expect(r.error.message).toContain("]");
      expect(r.error.message).toContain("newline");
    }
  });

  it("the handler alone (no central stage) refuses too", async () => {
    v = makeTestVault({ files: { "Old.md": "body", "linker.md": LINKER } });
    expectRefused(await v.call("move_note", { vault: "test", from: "Old.md", to: "a|b.md" }));
    expect(v.read("linker.md")).toBe(LINKER);
  });

  it("a folder segment that cannot live in a path-form link is refused as well", async () => {
    v = makeTestVault({ files: { "Old.md": "body", "linker.md": LINKER }, centralAcl: true });
    expectRefused(await v.call("move_note", { vault: "test", from: "Old.md", to: "a#b/New.md" }));
    expect(v.read("linker.md")).toBe(LINKER);
  });

  it("an ordinary rename still rewrites the backlinks", async () => {
    v = makeTestVault({ files: { "Old.md": "body", "linker.md": LINKER }, centralAcl: true });
    const r = await v.call("move_note", { vault: "test", from: "Old.md", to: "New name.md" });
    expect(r.ok).toBe(true);
    expect(v.read("linker.md")).toBe(
      "See [[New name]] and ![[New name|pic]] and [m](New name) here.\n",
    );
  });
});

describe("write_note / copy_note refuse the same names (create and copy destinations)", () => {
  let v: TestVault | undefined;
  afterEach(() => v?.cleanup());

  it.each(HOSTILE)("write_note: %s", async (_l, name) => {
    v = makeTestVault({ centralAcl: true });
    const r = await v.call("write_note", { vault: "test", path: `${name}.md`, content: "x" });
    expectRefused(r);
  });

  it("copy_note", async () => {
    v = makeTestVault({ files: { "src.md": "hello" }, centralAcl: true });
    expectRefused(await v.call("copy_note", { vault: "test", from: "src.md", to: "a|b.md" }));
  });
});

describe("bulk_move_notes refuses the row, rewrites nothing", () => {
  it.each(HOSTILE)("%s", async (_l, name) => {
    const v = makeM6Vault({
      files: { "Old.md": "body", "linker.md": LINKER },
      register: (r, d) => {
        for (const t of buildBulkTools(d)) r.register(t);
      },
    });
    try {
      const r = await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        moves: [{ from: "Old.md", to: `${name}.md` }],
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { results: Array<{ ok: boolean; error?: { code: string } }> };
        expect(d.results[0]?.ok).toBe(false);
        expect(d.results[0]?.error?.code).toBe("invalid_input");
      }
      expect(v.read("linker.md")).toBe(LINKER);
      expect(v.exists("Old.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});

describe("move_attachment / write_attachment refuse the same names", () => {
  const ATT = HOSTILE;
  it.each(ATT)("move_attachment: %s", async (_l, name) => {
    const v = makeM3Vault({
      files: { "pic.png": "x", "linker.md": "see ![[pic.png]] and [[pic.png]]\n" },
    });
    try {
      const r = await v.callConfirmed("move_attachment", {
        vault: "test",
        from: "pic.png",
        to: `${name}.png`,
      });
      expectRefused(r);
      expect(v.read("linker.md")).toBe("see ![[pic.png]] and [[pic.png]]\n");
      expect(v.read("pic.png")).toBe("x");
    } finally {
      v.cleanup();
    }
  });

  it("write_attachment", async () => {
    const v = makeM3Vault();
    try {
      expectRefused(
        await v.call("write_attachment", { vault: "test", path: "a|b.png", content: PNG_B64 }),
      );
    } finally {
      v.cleanup();
    }
  });
});

describe("rewrite_link refuses a to_target that is not exactly one link target", () => {
  const TARGETS: Array<[string, string]> = [
    ["close-and-inject", "foo]]\nInjected"],
    ["close and open a second link", "x]] and [[y"],
    ["alias pipe", "a|b"],
    ["newline", "a\nb"],
    ["comment percent pair", "a%%b"],
  ];

  async function elicited(v: TestVault, input: Record<string, unknown>): Promise<ToolResult> {
    const first = await v.call("rewrite_link", input);
    if (first.ok || first.error.code !== "elicit_required") return first;
    const token = issueElicitToken(v.db, {
      vaultId: "test",
      toolName: "rewrite_link",
      argsHash: (first.error as unknown as { details: { args_hash: string } }).details.args_hash,
      caller: "test",
    });
    return v.call("rewrite_link", input, { elicitToken: token });
  }

  it.each(TARGETS)("%s (dry run and real run)", async (_l, to_target) => {
    const v = makeTestVault({ files: { "Old.md": "x", "linker.md": LINKER } });
    try {
      expectRefused(await v.call("rewrite_link", { vault: "test", from_target: "Old", to_target }));
      expectRefused(
        await elicited(v, { vault: "test", from_target: "Old", to_target, dry_run: false }),
      );
      expect(v.read("linker.md")).toBe(LINKER);
    } finally {
      v.cleanup();
    }
  });

  it("a plain target still rewrites", async () => {
    const v = makeTestVault({ files: { "Old.md": "x", "linker.md": LINKER } });
    try {
      const r = await elicited(v, {
        vault: "test",
        from_target: "Old",
        to_target: "Some Folder/New",
        dry_run: false,
      });
      expect(r.ok).toBe(true);
      expect(v.read("linker.md")).toBe(
        "See [[Some Folder/New]] and ![[Some Folder/New|pic]] and [m](Some Folder/New) here.\n",
      );
    } finally {
      v.cleanup();
    }
  });
});

describe("rewriteLinks proves each rewritten link (defence in depth)", () => {
  const map = (to: string) => (t: string) => (t === "Old" ? to : null);

  it.each([
    ["wikilink closes early and injects", "Old [[Old]]", "foo]]\nInjected"],
    ["wikilink closes early on one line", "Old [[Old]] tail", "foo]] injected [[bar"],
    ["embed alias split", "![[Old]]", "a|b"],
    ["markdown url closes early", "[x](Old)", "a) injected (b"],
    ["markdown url with newline", "[x](Old)", "a\nb"],
    ["trailing bracket", "[[Old]]", "[br]"],
    ["wikilink with only a line break", "[[Old]]", "a\nb"],
    ["wikilink with only a carriage return", "[[Old]]", "a\rb"],
    ["wikilink with a comment marker", "[[Old]]", "a%%b"],
  ])("refuses: %s", (_l, text, to) => {
    expect(() => rewriteLinks(text, map(to))).toThrow(/invalid_input|cannot be written|link/i);
  });

  it("refuses a hostile target in a frontmatter property too", () => {
    expect(() => rewriteLinks('---\nup: "[[Old]]"\n---\nbody\n', map("a]]\nb"))).toThrow();
  });

  it("refuses an alias split on a link that already has an alias", () => {
    expect(() => rewriteLinks("[[Old|x]]", map("a|b"))).toThrow(/link/);
  });

  it("a to_target may end in its own heading (free-text target, not a file name)", () => {
    const out = rewriteLinks("[[Old]] and [[Old|x]]\n", map("New note#Intro"));
    expect(out.text).toBe("[[New note#Intro]] and [[New note#Intro|x]]\n");
  });

  it("keeps the heading and alias around a safe target", () => {
    const out = rewriteLinks("[[Old#Sec|shown]] and ![[Old]]\n", map("New name"));
    expect(out.text).toBe("[[New name#Sec|shown]] and ![[New name]]\n");
    expect(out.count).toBe(2);
  });

  it("keeps an escaped table pipe", () => {
    const out = rewriteLinks("| [[Old\\|shown]] |\n", map("New"));
    expect(out.text).toBe("| [[New\\|shown]] |\n");
  });

  it("leaves links in fenced code alone, hostile target or not", () => {
    const text = "```\n[[Old]]\n```\n";
    expect(rewriteLinks(text, map("a]]\nb")).text).toBe(text);
  });
});

describe("existing files with awkward names stay readable, updatable and movable", () => {
  let v: TestVault | undefined;
  afterEach(() => v?.cleanup());

  const AWKWARD = "legacy/a#b^c [x] d|e.md";
  function build(): TestVault {
    const t = makeTestVault({ centralAcl: true, files: { "linker.md": "See [[Old]]\n" } });
    mkdirSync(join(t.root, "legacy"), { recursive: true });
    writeFileSync(join(t.root, AWKWARD), "");
    writeFileSync(join(t.root, "legacy", "plain.md"), "plain");
    return t;
  }

  it("read_note and an in-place overwrite", async () => {
    v = build();
    expect((await v.call("read_note", { vault: "test", path: AWKWARD })).ok).toBe(true);
    const upd = await v.call("write_note", {
      vault: "test",
      path: AWKWARD,
      content: "new",
      mode: "overwrite",
    });
    expect(upd.ok).toBe(true);
    expect(v.read(AWKWARD)).toBe("new");
  });

  it("an existing awkward-named note can be moved to a safe name", async () => {
    v = build();
    const r = await v.call("move_note", {
      vault: "test",
      from: AWKWARD,
      to: "legacy/safe.md",
      update_backlinks: false,
    });
    expect(r.ok).toBe(true);
    expect(v.exists("legacy/safe.md")).toBe(true);
  });

  it("a note inside an EXISTING folder with an awkward name can be updated in place", async () => {
    v = makeTestVault({ centralAcl: true });
    mkdirSync(join(v.root, "C#"), { recursive: true });
    writeFileSync(join(v.root, "C#", "n.md"), "");
    const r = await v.call("write_note", {
      vault: "test",
      path: "C#/n.md",
      content: "new",
      mode: "overwrite",
    });
    expect(r.ok).toBe(true);
  });
});
