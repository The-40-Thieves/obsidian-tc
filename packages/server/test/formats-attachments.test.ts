import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ATTACHMENT_EXTS,
  findAttachmentReferences,
  isAttachment,
  mimeOf,
  resolveAttachmentFolder,
  rewriteAttachmentReferences,
} from "../src/formats/attachments";

function makeRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "obtc-att-"));
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
      for (const r of [r1, r2, r3, r4]) rmSync(r, { recursive: true, force: true });
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rewrites references on move, preserving bare-basename vs path link style", () => {
    const root = makeRoot({
      "a.md": "see ![[diagram.png]] and [pdf](docs/spec.pdf)\n",
    });
    try {
      const r1 = rewriteAttachmentReferences(root, "diagram.png", "images/renamed.png");
      expect(r1).toEqual({ notes: 1, refs: 1 });
      expect(readFileSync(join(root, "a.md"), "utf8")).toContain("![[renamed.png]]");

      const r2 = rewriteAttachmentReferences(root, "docs/spec.pdf", "archive/spec.pdf");
      expect(r2).toEqual({ notes: 1, refs: 1 });
      expect(readFileSync(join(root, "a.md"), "utf8")).toContain("[pdf](archive/spec.pdf)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
