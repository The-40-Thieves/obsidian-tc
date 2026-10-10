// Two client limits drive this: the Claude API connector replaces an image with a text placeholder,
// and Grok Build drops `resource_link` blocks outright. A result whose only content is such a block
// is empty to those clients. No tool emits one today (get_attachment returns its bytes inside the
// JSON text, with a `description` sentence), so the guard is at the one place every result passes
// (ensureTextContent), plus a source scan so a new emitter cannot arrive without going through it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureTextContent } from "../src/mcp/tool-result";

const PNG = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

describe("ensureTextContent: non-text blocks always have a text alternative", () => {
  it("an image-only result gets text naming the media type", () => {
    const out = ensureTextContent({ content: [PNG] });
    expect(textOf(out as never)).toMatch(/image\/png/);
    // The block itself is kept for clients that can render it.
    expect(out.content.some((b) => b.type === "image")).toBe(true);
  });

  it("an audio-only result gets text naming the media type", () => {
    const out = ensureTextContent({
      content: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }],
    });
    expect(textOf(out as never)).toMatch(/audio\/wav/);
  });

  it("a resource_link-only result gets text carrying the URI", () => {
    const out = ensureTextContent({
      content: [{ type: "resource_link", uri: "obsidian-tc://v1/notes/a.md", name: "a.md" }],
    });
    expect(textOf(out as never)).toContain("obsidian-tc://v1/notes/a.md");
  });

  it("an embedded blob resource gets text carrying the URI and media type", () => {
    const out = ensureTextContent({
      content: [
        {
          type: "resource",
          resource: { uri: "file:///x.pdf", mimeType: "application/pdf", blob: "AAAA" },
        },
      ],
    });
    const t = textOf(out as never);
    expect(t).toContain("file:///x.pdf");
    expect(t).toContain("application/pdf");
  });

  it("a resource_link next to text that never mentions its URI still surfaces the URI", () => {
    // Grok Build drops the block; the sentence beside it must not be the only trace of it.
    const out = ensureTextContent({
      content: [
        { type: "text", text: "Saved." },
        { type: "resource_link", uri: "obsidian-tc://v1/notes/b.md", name: "b.md" },
      ],
    });
    expect(textOf(out as never)).toContain("obsidian-tc://v1/notes/b.md");
    expect(textOf(out as never)).toContain("Saved.");
  });

  it("leaves a result that already says it unchanged (nothing doubled)", () => {
    const r = {
      content: [
        { type: "text" as const, text: "a screenshot (image/png) at obsidian-tc://v1/a.png" },
        PNG,
        { type: "resource_link" as const, uri: "obsidian-tc://v1/a.png", name: "a.png" },
      ],
    };
    expect(ensureTextContent(r)).toBe(r);
  });
});

describe("no tool emits a non-text block that bypasses the guard", () => {
  // Source scan with an existence floor (a scan over zero files proves nothing).
  const root = join(__dirname, "..", "src");
  const files = (readdirSync(root, { recursive: true, encoding: "utf8" }) as string[])
    .filter((n) => n.endsWith(".ts"))
    .map((n) => join(root, n));
  const EMITTERS = /type:\s*["'](image|audio|resource_link|resource)["']/;

  it("scans a real file set", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it("src has no content-block constructor for image/audio/resource_link/resource", () => {
    const hits = files.filter((f) => EMITTERS.test(readFileSync(f, "utf8")));
    // The guard itself only READS these types (`b.type === "image"`), it never builds one with a
    // `type: "..."` literal; a hit means a new emitter, which must come with its own alt-text test.
    expect(hits.map((f) => f.slice(root.length))).toEqual([]);
  });
});
