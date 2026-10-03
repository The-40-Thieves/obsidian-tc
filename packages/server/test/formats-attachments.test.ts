import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ATTACHMENT_EXTS,
  findAttachmentReferences,
  isAttachment,
  mimeOf,
  planAttachmentReferences,
  resolveAttachmentFolder,
} from "../src/formats/attachments";
import { ImmutableRewriteSkips } from "../src/vault/acl-path";
import { applyWriteBatch } from "../src/vault/write-batch";
import { makeTempDir, rmTemp } from "./tmp";

/** A guard with no ACL: nothing is immutable (these tests are about the rewrite itself). */
const noSkips = (root: string): ImmutableRewriteSkips =>
  new ImmutableRewriteSkips(undefined, root, []);

/** Plan a reference rewrite and commit it as the batch move_attachment uses. */
function rewriteAttachmentReferences(
  root: string,
  fromRel: string,
  toRel: string,
  skips: ImmutableRewriteSkips,
): { notes: number; refs: number } {
  const { pending } = planAttachmentReferences(root, fromRel, toRel, skips, undefined, undefined);
  applyWriteBatch(
    pending.map((r) => ({
      abs: r.abs,
      rel: r.rel,
      content: r.text,
      prevRaw: r.raw,
      createDirs: false,
    })),
  );
  return { notes: pending.length, refs: pending.reduce((n, r) => n + r.count, 0) };
}

function makeRoot(files: Record<string, string>): string {
  const root = makeTempDir("obtc-att-");
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

describe("formats/attachments", () => {
  it("classifies MIME types and attachment extensions", () => {
    expect(mimeOf("x.png")).toBe("image/png");
    expect(mimeOf("docs/a.pdf")).toBe("application/pdf");
    expect(mimeOf("y.unknownext")).toBe("application/octet-stream");
    expect(isAttachment("a.png")).toBe(true);
    expect(isAttachment("note.md")).toBe(false);
    expect(isAttachment("a.PNG")).toBe(true);
    expect(DEFAULT_ATTACHMENT_EXTS).toContain(".pdf");
  });

  it("resolves the configured attachment folder, treating root and note-relative as none", () => {
    const r1 = makeRoot({
      ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: "Files" }),
    });
    const r2 = makeRoot({ ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: "/" }) });
    const r3 = makeRoot({
      ".obsidian/app.json": JSON.stringify({ attachmentFolderPath: "./att" }),
    });
    const r4 = makeRoot({ "a.md": "x" });
    try {
      expect(resolveAttachmentFolder(r1)).toBe("Files");
      expect(resolveAttachmentFolder(r2)).toBe("");
      expect(resolveAttachmentFolder(r3)).toBe("");
      expect(resolveAttachmentFolder(r4)).toBe("");
    } finally {
      for (const r of [r1, r2, r3, r4]) rmTemp(r);
    }
  });

  it("finds note references by wikilink-embed basename and by markdown path", () => {
    const root = makeRoot({
      "a.md": "see ![[diagram.png]] and [pdf](docs/spec.pdf)\n",
      "b.md": "no attachments here\n",
      "code.md": "```\n![[diagram.png]]\n```\n",
    });
    try {
      expect(findAttachmentReferences(root, "diagram.png")).toEqual(["a.md"]);
      expect(findAttachmentReferences(root, "docs/spec.pdf")).toEqual(["a.md"]);
      expect(findAttachmentReferences(root, "absent.png")).toEqual([]);
    } finally {
      rmTemp(root);
    }
  });

  it("rewrites references on move, preserving bare-basename vs path link style", () => {
    const root = makeRoot({
      "a.md": "see ![[diagram.png]] and [pdf](docs/spec.pdf)\n",
    });
    try {
      const r1 = rewriteAttachmentReferences(
        root,
        "diagram.png",
        "images/renamed.png",
        noSkips(root),
      );
      expect(r1).toEqual({ notes: 1, refs: 1 });
      expect(readFileSync(join(root, "a.md"), "utf8")).toContain("![[renamed.png]]");

      const r2 = rewriteAttachmentReferences(
        root,
        "docs/spec.pdf",
        "archive/spec.pdf",
        noSkips(root),
      );
      expect(r2).toEqual({ notes: 1, refs: 1 });
      expect(readFileSync(join(root, "a.md"), "utf8")).toContain("[pdf](archive/spec.pdf)");
    } finally {
      rmTemp(root);
    }
  });

  it("does NOT repoint a same-basename path link to a different folder's file", () => {
    const root = makeRoot({
      "a/diagram.png": "A",
      "b/diagram.png": "B",
      "note.md": "bare ![[diagram.png]] and path [x](b/diagram.png)\n",
    });
    try {
      const r = rewriteAttachmentReferences(root, "a/diagram.png", "a/renamed.png", noSkips(root));
      const txt = readFileSync(join(root, "note.md"), "utf8");
      // bare-basename link resolves to a/diagram.png (shortest/lex winner) -> rewritten
      expect(txt).toContain("![[renamed.png]]");
      // path link to the OTHER file is left untouched (the bug this fixes)
      expect(txt).toContain("[x](b/diagram.png)");
      expect(r.notes).toBe(1);
      expect(r.refs).toBe(1);
    } finally {
      rmTemp(root);
    }
  });

  it("repoints a path-style link only when it matches the moved file exactly", () => {
    const root = makeRoot({
      "a/diagram.png": "A",
      "b/diagram.png": "B",
      "note.md": "[x](a/diagram.png) and [y](b/diagram.png)\n",
    });
    try {
      rewriteAttachmentReferences(root, "a/diagram.png", "a/renamed.png", noSkips(root));
      const txt = readFileSync(join(root, "note.md"), "utf8");
      expect(txt).toContain("[x](a/renamed.png)");
      expect(txt).toContain("[y](b/diagram.png)");
    } finally {
      rmTemp(root);
    }
  });

  it("emits a full path (not bare) when the moved basename stays ambiguous post-move", () => {
    const root = makeRoot({
      "a/diagram.png": "A",
      "b/diagram.png": "B",
      "note.md": "bare ![[diagram.png]]\n",
    });
    try {
      // Move a/diagram.png -> c/diagram.png: the basename "diagram.png" is still shared
      // with b/diagram.png, so a bare ![[diagram.png]] would now resolve to b/ — the
      // rewrite must therefore emit the full path to stay pointed at the moved file.
      rewriteAttachmentReferences(root, "a/diagram.png", "c/diagram.png", noSkips(root));
      const txt = readFileSync(join(root, "note.md"), "utf8");
      expect(txt).toContain("![[c/diagram.png]]");
      expect(txt).not.toContain("![[diagram.png]]");
    } finally {
      rmTemp(root);
    }
  });
});
