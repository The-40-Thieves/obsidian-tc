// Windows name canonicalization for vault WRITES. A vault syncs across operating systems, so the
// Windows-hostile name shapes are refused on every platform: a `:` in a segment (on NTFS
// `report.md:.png` names the `.png` alternate data stream of `report.md`), a trailing `.` or space
// (Win32 strips it, so `a.md.` aliases `a.md`), and the reserved device names with any extension.
//
// Decision (documented in enforcePathAcl / assertWritableVaultPath): the refusal applies to a write
// that would CREATE the name (create / move / rename / copy targets). A file that already exists
// under such a name on this filesystem stays readable and updatable in place, so a vault synced from
// a Linux box is not made unreadable.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { isAttachment, mimeOf } from "../src/formats/attachments";
import { normalizeVaultPath } from "../src/vault/paths";
import { makeTestVault, type TestVault } from "./m1-helpers";
import { makeM3Vault } from "./m3-helpers";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

// The hostile shapes: [label, path].
const HOSTILE_NOTES: Array<[string, string]> = [
  ["ADS stream", "report.md:.md"],
  ["colon in a folder segment", "dir:x/a.md"],
  ["drive-like colon mid-name", "a:b.md"],
  ["trailing dot", "a.md."],
  ["trailing space", "a.md "],
  ["trailing dot in folder", "dir./a.md"],
  ["reserved CON", "CON.md"],
  ["reserved lowercase nul", "sub/nul.md"],
  ["reserved COM1 with second ext", "com1.tar.md"],
  ["reserved LPT9 folder", "lpt9/a.md"],
];

describe("VaultPath / normalizeVaultPath still admit hostile names for READS", () => {
  it("shared VaultPath does not refuse them (a read of an existing file must keep working)", () => {
    for (const [, p] of HOSTILE_NOTES.filter(([l]) => !l.startsWith("reserved")))
      expect(VaultPath.safeParse(p).success, p).toBe(true);
  });
  it("normalizeVaultPath keeps its long-standing reserved-name refusal (unchanged)", () => {
    expect(() => normalizeVaultPath("CON.md")).toThrow(/reserved/);
  });
});

describe("extOf is taken from the last path SEGMENT", () => {
  it("a `:` stream suffix or a dotted folder cannot smuggle an extension", () => {
    expect(isAttachment("report.md:.png")).toBe(false);
    expect(mimeOf("report.md:.png")).toBe("application/octet-stream");
    // the dot lives in the folder name, the file has no extension at all
    expect(isAttachment("a.png/readme")).toBe(false);
    expect(isAttachment("a.b/pic.png")).toBe(true);
  });
});

describe("write_note / move_note / copy_note refuse hostile targets", () => {
  let v: TestVault | undefined;
  afterEach(() => v?.cleanup());

  it.each(HOSTILE_NOTES)("write_note: %s", async (_label, path) => {
    v = makeTestVault({ centralAcl: true });
    const r = await v.call("write_note", { vault: "test", path, content: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("path_invalid");
  });

  it.each(HOSTILE_NOTES)(
    "write_note through the central stage: %s writes nothing",
    async (_l, p) => {
      v = makeTestVault({ centralAcl: true });
      await v.call("write_note", { vault: "test", path: p, content: "x" });
      expect(v.exists(p)).toBe(false);
    },
  );

  it.each(HOSTILE_NOTES)("move_note destination: %s", async (_label, to) => {
    v = makeTestVault({ files: { "src.md": "hello" }, centralAcl: true });
    const r = await v.call("move_note", { vault: "test", from: "src.md", to });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("path_invalid");
    // the source is untouched
    expect(v.read("src.md")).toBe("hello");
  });

  it("copy_note destination", async () => {
    v = makeTestVault({ files: { "src.md": "hello" }, centralAcl: true });
    const r = await v.call("copy_note", { vault: "test", from: "src.md", to: "a:b.md" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("path_invalid");
  });

  it("an EXISTING file with a hostile name is still readable and updatable in place", async () => {
    v = makeTestVault({ centralAcl: true });
    // Reserved names are already refused by normalizeVaultPath (reads too), so use the colon and
    // trailing-dot shapes a Linux-synced vault can legitimately hold.
    mkdirSync(join(v.root, "legacy"), { recursive: true });
    // Empty, so overwriting it needs no HITL confirmation (that gate is not what is under test).
    writeFileSync(join(v.root, "legacy", "a:b.md"), "");
    const read = await v.call("read_note", { vault: "test", path: "legacy/a:b.md" });
    expect(read.ok).toBe(true);
    const upd = await v.call("write_note", {
      vault: "test",
      path: "legacy/a:b.md",
      content: "new",
      mode: "overwrite",
    });
    expect(upd.ok).toBe(true);
    expect(v.read("legacy/a:b.md")).toBe("new");
  });
});

describe("write_attachment / create_canvas refuse hostile targets", () => {
  const ATT: Array<[string, string]> = [
    ["ADS onto a note", "report.md:.png"],
    ["ADS onto an attachment", "pic.png:.png"],
    ["trailing dot", "pic.png."],
    ["trailing space", "pic.png "],
    ["reserved AUX", "AUX.png"],
    ["colon folder", "a:b/pic.png"],
  ];

  it.each(ATT)("write_attachment: %s", async (_l, path) => {
    const v = makeM3Vault();
    try {
      const r = await v.call("write_attachment", { vault: "test", path, content: PNG_B64 });
      expect(r.ok).toBe(false);
      // `.md:.png` must not pass as `.png`; whichever guard fires, nothing lands on disk
      expect(v.exists(path)).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("write_attachment refuses the ADS shape and leaves the note untouched", async () => {
    const v = makeM3Vault({ files: { "report.md": "note" } });
    try {
      const r = await v.call("write_attachment", {
        vault: "test",
        path: "report.md:.png",
        content: PNG_B64,
      });
      expect(r.ok).toBe(false);
      // `.md:.png` reads as `.md` now, so the extension guard may fire before the name guard;
      // either way nothing is written.
      if (!r.ok) expect(["path_invalid", "invalid_input"]).toContain(r.error.code);
      expect(v.read("report.md")).toBe("note");
    } finally {
      v.cleanup();
    }
  });

  it.each([
    ["ADS", "board.canvas:.canvas"],
    ["colon", "a:b.canvas"],
    ["trailing-dot folder", "dir./board.canvas"],
    ["reserved", "NUL.canvas"],
  ])("create_canvas: %s", async (_l, path) => {
    const v = makeM3Vault();
    try {
      const r = await v.call("create_canvas", { vault: "test", path, nodes: [], edges: [] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("path_invalid");
      expect(v.exists(path)).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("move_attachment destination", async () => {
    const v = makeM3Vault({ files: { "a.png": "x" } });
    try {
      const r = await v.callConfirmed("move_attachment", {
        vault: "test",
        from: "a.png",
        to: "a.md:.png",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("path_invalid");
      expect(v.read("a.png")).toBe("x");
    } finally {
      v.cleanup();
    }
  });
});
