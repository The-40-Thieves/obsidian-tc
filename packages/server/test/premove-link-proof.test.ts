// The backlink rewrite splices the destination into link syntax, and rewriteLinks refuses a link it
// cannot prove. That proof used to run AFTER move_note / move_attachment / bulk_move_notes had
// committed the move, so a refusal left the file moved, its backlinks stale, and a retry answering
// indeterminate_outcome. A destination can be link-hostile even though its NEW segments pass the
// name check: an EXISTING folder `a|b/` or `C#/` is exempt (a file already on disk stays usable), and
// `Report (final).md` closes a markdown link early at its `)`.
//
// Pinned here: the whole rewrite is planned and proven BEFORE anything is written, the refusal is
// an invalid_input naming the note and the destination, and nothing moves. Also: a `#` or `^` in a
// path segment is unrepresentable in a path-qualified link (the proof compares the parsed target to
// the intended one exactly), while a unique-basename bare link stays fine.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ToolResult, wikiLinkNameProblem } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { renderEntityNote } from "../src/memory/materialize";
import { buildBulkTools } from "../src/tools/m6/bulk-tools";
import { scanWikilinks } from "../src/vault/link-scan";
import { rewriteLinks } from "../src/vault/rewrite";
import { makeTestVault, type TestVault } from "./m1-helpers";
import { makeM3Vault } from "./m3-helpers";
import { makeM6Vault } from "./m6-helpers";

function expectRefused(r: ToolResult): void {
  expect(r.ok, JSON.stringify(r)).toBe(false);
  if (!r.ok) expect(r.error.code).toBe("invalid_input");
}

/** A cross-folder move asks for confirmation first; confirm when asked, else return the refusal. */
async function confirming(
  v: Pick<TestVault, "call" | "db" | "id">,
  tool: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const first = await v.call(tool, input);
  if (first.ok || first.error.code !== "elicit_required") return first;
  const argsHash = String((first.error.details as { args_hash?: string }).args_hash);
  const elicitToken = issueElicitToken(v.db, {
    vaultId: v.id,
    toolName: tool,
    argsHash,
    caller: "test",
  });
  return v.call(tool, input, { elicitToken });
}

const moveNote = (v: TestVault, input: Record<string, unknown>) =>
  confirming(v, "move_note", input);

function folderWith(root: string, folder: string, file = "keep.md"): void {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, file), "kept");
}

// A same-basename note elsewhere makes the bare basename ambiguous after the move, so the rewrite
// has to emit the PATH form, which is the form an existing hostile folder breaks.
const COLLIDING = { "Note.md": "body", "other/Note.md": "other", "linker.md": "See [[Note]].\n" };

describe("move_note plans the backlink rewrite before it moves anything", () => {
  let v: TestVault | undefined;
  afterEach(() => v?.cleanup());

  it.each([
    ["a|b", "a|b/Note.md"],
    ["C#", "C#/Note.md"],
    ["a^b", "a^b/Note.md"],
    ["a]b", "a]b/Note.md"],
    ["a%%b", "a%%b/Note.md"],
  ])("existing folder %s with a basename collision: refused, nothing moved", async (folder, to) => {
    v = makeTestVault({ files: COLLIDING });
    folderWith(v.root, folder);
    const r = await moveNote(v, { vault: "test", from: "Note.md", to });
    expectRefused(r);
    expect(v.exists("Note.md")).toBe(true);
    expect(v.read("Note.md")).toBe("body");
    expect(v.exists(to)).toBe(false);
    expect(v.read("linker.md")).toBe("See [[Note]].\n");
  });

  it("the refusal names the note whose link cannot be written and the target", async () => {
    v = makeTestVault({ files: COLLIDING });
    folderWith(v.root, "C#");
    const r = await moveNote(v, { vault: "test", from: "Note.md", to: "C#/Note.md" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.details).toMatchObject({ note: "linker.md", target: "C#/Note" });
      expect(r.error.message).toContain("linker.md");
    }
  });

  it("a retry after the refusal is still a plain refusal, not indeterminate_outcome", async () => {
    v = makeTestVault({ files: COLLIDING });
    folderWith(v.root, "a|b");
    const input = { vault: "test", from: "Note.md", to: "a|b/Note.md" };
    expectRefused(await moveNote(v, input));
    expectRefused(await moveNote(v, input));
  });

  it("a unique basename in an existing C#/ folder moves with a correct bare link", async () => {
    v = makeTestVault({ files: { "Fresh.md": "body", "linker.md": "See [[Fresh]].\n" } });
    folderWith(v.root, "C#");
    const r = await moveNote(v, { vault: "test", from: "Fresh.md", to: "C#/Fresh.md" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(v.exists("C#/Fresh.md")).toBe(true);
    expect(v.read("linker.md")).toBe("See [[Fresh]].\n");
  });

  it("an existing a|b/ folder with a unique basename and a rename writes the bare link", async () => {
    v = makeTestVault({ files: { "Old.md": "body", "linker.md": "See [[Old]].\n" } });
    folderWith(v.root, "a|b");
    const r = await moveNote(v, { vault: "test", from: "Old.md", to: "a|b/Fresh.md" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(v.read("linker.md")).toBe("See [[Fresh]].\n");
  });

  it("a markdown-link backlink to a name holding ) is refused before the move", async () => {
    v = makeTestVault({ files: { "Old.md": "body", "linker.md": "See [x](Old.md).\n" } });
    const r = await moveNote(v, { vault: "test", from: "Old.md", to: "Report (final).md" });
    expectRefused(r);
    expect(v.exists("Old.md")).toBe(true);
    expect(v.exists("Report (final).md")).toBe(false);
    expect(v.read("linker.md")).toBe("See [x](Old.md).\n");
  });

  it("a wikilink-only backlink to a name holding ) is fine", async () => {
    v = makeTestVault({ files: { "Old.md": "body", "linker.md": "See [[Old]].\n" } });
    const r = await moveNote(v, { vault: "test", from: "Old.md", to: "Report (final).md" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(v.read("linker.md")).toBe("See [[Report (final)]].\n");
  });

  it("update_backlinks:false never plans, so a hostile destination folder is not an issue", async () => {
    v = makeTestVault({ files: { ...COLLIDING } });
    folderWith(v.root, "C#");
    const r = await moveNote(v, {
      vault: "test",
      from: "Note.md",
      to: "C#/Note.md",
      update_backlinks: false,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});

describe("bulk_move_notes is all-or-nothing", () => {
  const build = (files: Record<string, string>) =>
    makeM6Vault({
      files,
      register: (r, d) => {
        for (const t of buildBulkTools(d)) r.register(t);
      },
    });

  it("one row whose link cannot be written refuses the whole batch; nothing moved", async () => {
    const v = build({ ...COLLIDING, "Plain.md": "p", "l2.md": "[[Plain]]\n" });
    try {
      folderWith(v.root, "C#");
      const r = await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        moves: [
          { from: "Plain.md", to: "Renamed.md" },
          { from: "Note.md", to: "C#/Note.md" },
        ],
      });
      expectRefused(r);
      expect(v.exists("Plain.md")).toBe(true);
      expect(v.exists("Renamed.md")).toBe(false);
      expect(v.exists("Note.md")).toBe(true);
      expect(v.exists("C#/Note.md")).toBe(false);
      expect(v.read("l2.md")).toBe("[[Plain]]\n");
      expect(v.read("linker.md")).toBe("See [[Note]].\n");
    } finally {
      v.cleanup();
    }
  });

  it("a markdown link to a name holding ) refuses the batch before any move", async () => {
    const v = build({ "Old.md": "body", "linker.md": "See [x](Old.md).\n" });
    try {
      const r = await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        moves: [{ from: "Old.md", to: "Report (final).md" }],
      });
      expectRefused(r);
      expect(v.exists("Old.md")).toBe(true);
      expect(v.exists("Report (final).md")).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("a clean batch still moves and rewrites", async () => {
    const v = build({ "Old.md": "body", "linker.md": "See [[Old]].\n" });
    try {
      const r = await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        moves: [{ from: "Old.md", to: "Fresh.md" }],
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(v.read("linker.md")).toBe("See [[Fresh]].\n");
    } finally {
      v.cleanup();
    }
  });
});

describe("move_attachment plans the reference rewrite before it moves anything", () => {
  const FILES = {
    "pic.png": "x",
    "other/pic.png": "y",
    "linker.md": "see ![[pic.png]] and [[pic.png]]\n",
  };

  it.each(["a|b", "C#", "a^b"])("existing folder %s with a basename collision", async (folder) => {
    const v = makeM3Vault({ files: FILES });
    try {
      folderWith(v.root, folder, "keep.png");
      const r = await confirming(v, "move_attachment", {
        vault: "test",
        from: "pic.png",
        to: `${folder}/pic.png`,
      });
      expectRefused(r);
      expect(v.read("pic.png")).toBe("x");
      expect(v.exists(`${folder}/pic.png`)).toBe(false);
      expect(v.read("linker.md")).toBe(FILES["linker.md"]);
    } finally {
      v.cleanup();
    }
  });

  it("a unique basename in an existing C#/ folder moves and keeps the bare link", async () => {
    const v = makeM3Vault({ files: { "pic.png": "x", "linker.md": "see ![[pic.png]]\n" } });
    try {
      folderWith(v.root, "C#", "keep.png");
      const r = await confirming(v, "move_attachment", {
        vault: "test",
        from: "pic.png",
        to: "C#/pic.png",
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(v.read("linker.md")).toBe("see ![[pic.png]]\n");
    } finally {
      v.cleanup();
    }
  });

  it("a markdown image link to a name holding ) is refused before the move", async () => {
    const v = makeM3Vault({ files: { "pic.png": "x", "linker.md": "![alt](pic.png)\n" } });
    try {
      const r = await confirming(v, "move_attachment", {
        vault: "test",
        from: "pic.png",
        to: "pic (1).png",
      });
      expectRefused(r);
      expect(v.read("pic.png")).toBe("x");
      expect(v.exists("pic (1).png")).toBe(false);
    } finally {
      v.cleanup();
    }
  });
});

describe("rewriteLinks strict targets (the move proof)", () => {
  const map = (to: string) => () => to;
  const strict = { exactTarget: true };

  it.each(["C#/Note", "a^b/Note"])(
    "a path-qualified wikilink target %j is unrepresentable",
    (to) => {
      expect(() => rewriteLinks("[[Old]]", map(to), strict)).toThrow(/cannot be written/);
    },
  );

  it("the free-text mode (rewrite_link) still lets the target carry its own heading", () => {
    expect(rewriteLinks("[[Old]]", map("Note#Heading")).text).toBe("[[Note#Heading]]");
  });

  it("a heading and alias on the old link survive a strict rewrite", () => {
    expect(rewriteLinks("[[Old#H|shown]]", map("dir/New"), strict).text).toBe(
      "[[dir/New#H|shown]]",
    );
  });

  it("a markdown target holding ) or # is refused", () => {
    expect(() => rewriteLinks("[x](Old.md)", map("Report (final)"), strict)).toThrow();
    expect(() => rewriteLinks("[x](Old.md)", map("C#/Note"), strict)).toThrow();
  });

  it("a frontmatter property value with # is refused under strict", () => {
    expect(() => rewriteLinks('---\nup: "[[Old]]"\n---\nbody\n', map("C#/Note"), strict)).toThrow();
  });
});

describe("renderEntityNote links are link-safe", () => {
  const render = (targetName: string) =>
    renderEntityNote({
      id: "e1",
      entityType: "person",
      name: "Alice",
      status: "active",
      observations: [],
      relations: [{ relationType: "knows", targetName }],
    });

  it.each([
    "Bob]]\n# Injected heading",
    "Bob]] and [[Eve",
    "Bob|alias",
    "Bob#heading",
    "Bob^block",
    "Bob%%comment",
    "Bob\u0007bell",
  ])("a relation target %j renders as exactly one clean link", (name) => {
    const out = render(name);
    const related = out.slice(out.indexOf("## Related"));
    const bullets = related.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(1);
    const links = scanWikilinks(bullets[0] ?? "");
    expect(links).toHaveLength(1);
    expect(related).not.toContain("# Injected");
    const inner = links[0]?.inner ?? "";
    expect(wikiLinkNameProblem(inner)).toBeNull();
    expect(inner.length).toBeGreaterThan(0);
  });

  it("an ordinary name is unchanged", () => {
    expect(render("Bob Smith")).toContain("- knows [[Bob Smith]]");
  });
});
