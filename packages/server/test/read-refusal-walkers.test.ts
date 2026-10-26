// A walker that reads every note skips one the safe open refuses (a hard link to a file outside the
// vault) instead of aborting the whole call. The refused note is counted in notes_read_refused and
// never named: the caller may not read it.
import { linkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeM2Vault } from "./m2-helpers";
import { makeM3Vault } from "./m3-helpers";
import { itemPaths, okData, TEXT_SEARCH_TOOLS } from "./read-refusal-helpers";
import { makeTempDir, rmTemp } from "./tmp";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** A file outside the vault, hard-linked in as n/hl.md: the safe open refuses that read. */
function outsideLink(root: string, text: string, rel = join("n", "hl.md")): void {
  const outside = makeTempDir("obtc-walk-refusal-out-");
  cleanups.push(() => rmTemp(outside));
  const src = join(outside, "src.md");
  writeFileSync(src, text);
  linkSync(src, join(root, rel));
}

/** The caller of the ACL vault below: it may read notes and attachments, not private/. */
const NO_PRIVATE = { grantedScopes: new Set(["read:notes", "read:attachments"]) };

describe("a clean vault's attachment walks carry no notes_read_refused key", () => {
  it("list_attachments and get_attachment", async () => {
    const v = makeM3Vault({ files: { "img.png": "png", "n/a.md": "![[img.png]]\n" } });
    cleanups.push(() => v.cleanup());
    const listed = okData(
      await v.call("list_attachments", { vault: "test", include_reference_count: true }),
    );
    expect(listed).not.toHaveProperty("notes_read_refused");
    const got = okData(
      await v.call("get_attachment", { vault: "test", path: "img.png", include_references: true }),
    );
    expect(got.references).toEqual(["n/a.md"]);
    expect(got).not.toHaveProperty("notes_read_refused");
  });
});

describe("a clean vault's permanent attachment delete is not refused", () => {
  it("delete_attachment permanent deletes the file", async () => {
    const v = makeM3Vault({ files: { "img.png": "png", "n/a.md": "![[img.png]]\n" } });
    cleanups.push(() => v.cleanup());
    const d = okData(
      await v.callConfirmed("delete_attachment", {
        vault: "test",
        path: "img.png",
        permanent: true,
      }),
    );
    expect(d.deleted).toBe(true);
    expect(v.exists("img.png")).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")(
  "walkers skip a hard-linked note and count it",
  () => {
    /** n/a.md embeds img.png; n/hl.md is a hard link to an outside note that embeds it too. */
    function attachmentVault() {
      const v = makeM3Vault({ files: { "img.png": "png", "n/a.md": "![[img.png]]\n" } });
      cleanups.push(() => v.cleanup());
      outsideLink(v.root, "![[img.png]]\n");
      return v;
    }

    it("list_attachments include_reference_count counts only the readable reference", async () => {
      const v = attachmentVault();
      const d = okData(
        await v.call("list_attachments", { vault: "test", include_reference_count: true }),
      );
      expect(d.attachments).toEqual([
        expect.objectContaining({ path: "img.png", reference_count: 1 }),
      ]);
      expect(d.notes_read_refused).toBe(1);
    });

    it("get_attachment include_references lists the readable referrer only", async () => {
      const v = attachmentVault();
      const d = okData(
        await v.call("get_attachment", {
          vault: "test",
          path: "img.png",
          include_references: true,
        }),
      );
      expect(d.references).toEqual(["n/a.md"]);
      expect(d.notes_read_refused).toBe(1);
    });

    it("list_attachments counts a hard-linked note once across attachments, concise too", async () => {
      const v = makeM3Vault({
        files: { "img.png": "png", "pic.png": "png", "n/a.md": "![[img.png]]\n![[pic.png]]\n" },
      });
      cleanups.push(() => v.cleanup());
      outsideLink(v.root, "![[img.png]]\n![[pic.png]]\n");
      for (const response_format of [undefined, "concise"] as const) {
        const d = okData(
          await v.call("list_attachments", {
            vault: "test",
            include_reference_count: true,
            response_format,
          }),
        );
        expect(d.attachments).toHaveLength(2);
        expect(d.notes_read_refused).toBe(1);
      }
    });

    it("an unreadable note is neither read nor counted by the attachment walks", async () => {
      const v = makeM3Vault({
        files: { "pub/img.png": "png", "pub/a.md": "![[img.png]]\n", "private/keep.md": "x" },
        acl: { rules: [{ glob: "private/**", scopes: ["read:private"] }] },
      });
      cleanups.push(() => v.cleanup());
      outsideLink(v.root, "![[img.png]]\n", join("private", "hl.md"));
      const got = okData(
        await v.call(
          "get_attachment",
          { vault: "test", path: "pub/img.png", include_references: true },
          NO_PRIVATE,
        ),
      );
      expect(got.references).toEqual(["pub/a.md"]);
      expect(got).not.toHaveProperty("notes_read_refused");
      const listed = okData(
        await v.call(
          "list_attachments",
          { vault: "test", folder: "pub", include_reference_count: true },
          NO_PRIVATE,
        ),
      );
      expect(listed.attachments).toEqual([
        expect.objectContaining({ path: "pub/img.png", reference_count: 1 }),
      ]);
      expect(listed).not.toHaveProperty("notes_read_refused");
    });

    it("delete_attachment deletes and reports the readable referrer and the refusal", async () => {
      const v = attachmentVault();
      const d = okData(
        await v.callConfirmed("delete_attachment", { vault: "test", path: "img.png" }),
      );
      expect(d.deleted).toBe(true);
      expect(d.references).toEqual(["n/a.md"]);
      expect(d.trashed_to).toEqual(expect.any(String));
      expect(v.exists("img.png")).toBe(false);
      expect(d.notes_read_refused).toBe(1);
    });

    it("delete_attachment permanent refuses when a note read was refused, and deletes nothing", async () => {
      const v = attachmentVault();
      const r = await v.callConfirmed("delete_attachment", {
        vault: "test",
        path: "img.png",
        permanent: true,
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("conflict");
      expect(r.error.details).toMatchObject({ notes_read_refused: 1 });
      expect(v.exists("img.png")).toBe(true);
    });

    describe.each(TEXT_SEARCH_TOOLS)("%s", (tool, args) => {
      it("returns the hits of the readable notes and counts the refusal", async () => {
        const v = makeM2Vault({ files: { "a.md": "zebra alpha\n", "n/a.md": "zebra beta\n" } });
        cleanups.push(() => v.cleanup());
        outsideLink(v.root, "zebra outside\n");
        const d = okData(await v.call(tool, { vault: "test", ...args }));
        expect(itemPaths(d)).toEqual(["a.md", "n/a.md"]);
        expect(d.notes_read_refused).toBe(1);
      });
    });

    it("search_text over an unconfigured symlinked alias returns no items and counts the refusal", async () => {
      const v = makeM2Vault({ files: { "pages/a.md": "zebra alpha\n" } });
      cleanups.push(() => v.cleanup());
      symlinkSync(join(v.root, "pages"), join(v.root, "wiki"), "dir");
      const d = okData(
        await v.call("search_text", { vault: "test", query: "zebra", root: "wiki" }),
      );
      expect(d.items).toEqual([]);
      expect(d.notes_read_refused).toBe(1);
    });
  },
);
