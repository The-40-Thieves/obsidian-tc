// Platform-independent twin of read-refusal-walkers.test.ts: the safe open's refusal is simulated by
// throwing acl_denied from readNote for one note, so the walkers' skip-and-count path runs on every
// OS (the hard-link and symlink fixtures are POSIX-only). A separate file: the readNote mock below
// must not reach any other test's module graph.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { err, type ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findAttachmentReferences } from "../src/formats/attachments";
import { searchRegex, searchText } from "../src/search/text";
import { ReadRefusals } from "../src/tools/read-refusals";
import { makeM2Vault } from "./m2-helpers";
import { makeM3Vault } from "./m3-helpers";
import { makeTempDir, rmTemp } from "./tmp";

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

function data(r: ToolResult): Record<string, unknown> {
  if (!r.ok) throw new Error(`call failed: ${JSON.stringify(r)}`);
  return r.data as Record<string, unknown>;
}

function paths(d: Record<string, unknown>): string[] {
  return (d.items as Array<{ path: string }>).map((i) => i.path).sort();
}

describe("a refused read is skipped and counted, not fatal", () => {
  it("findAttachmentReferences skips the refused note and counts it", () => {
    const root = makeTempDir("obtc-walk-refusal-mixed-");
    cleanups.push(() => rmTemp(root));
    for (const [rel, text] of [
      ["n/a.md", "![[img.png]]\n"],
      ["n/b.md", "![[img.png]]\n"],
    ] as const) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const refusals = new ReadRefusals();
    expect(findAttachmentReferences(root, "img.png", refusals).map((e) => e.relPath)).toEqual([
      "n/a.md",
    ]);
    expect(refusals.count).toBe(1);
  });

  it("searchText and searchRegex skip the refused note and count it", async () => {
    const root = makeTempDir("obtc-walk-refusal-mixed-");
    cleanups.push(() => rmTemp(root));
    for (const rel of ["n/a.md", "n/b.md"]) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), `zebra ${rel}\n`);
    }
    const refusals = new ReadRefusals();
    const text = searchText(root, { query: "zebra", limit: 100, refusals });
    expect(text.map((h) => h.path)).toEqual(["n/a.md"]);
    const regex = await searchRegex(root, { pattern: "zebra", limit: 100, refusals });
    expect(regex.map((h) => h.path)).toEqual(["n/a.md"]);
    expect(refusals.count).toBe(2);
  });

  it("list_attachments include_reference_count counts the readable reference and the refusal", async () => {
    const v = makeM3Vault({
      files: { "img.png": "png", "n/a.md": "![[img.png]]\n", "n/b.md": "![[img.png]]\n" },
    });
    cleanups.push(() => v.cleanup());
    const d = data(
      await v.call("list_attachments", { vault: "test", include_reference_count: true }),
    );
    expect(d.attachments).toEqual([
      expect.objectContaining({ path: "img.png", reference_count: 1 }),
    ]);
    expect(d.notes_read_refused).toBe(1);
  });

  it("search_text returns the readable hits and counts the refusal", async () => {
    const v = makeM2Vault({ files: { "a.md": "zebra alpha\n", "n/b.md": "zebra beta\n" } });
    cleanups.push(() => v.cleanup());
    const d = data(await v.call("search_text", { vault: "test", query: "zebra" }));
    expect(paths(d)).toEqual(["a.md"]);
    expect(d.notes_read_refused).toBe(1);
  });

  it("search_regex returns the readable hits and counts the refusal", async () => {
    const v = makeM2Vault({ files: { "a.md": "zebra alpha\n", "n/b.md": "zebra beta\n" } });
    cleanups.push(() => v.cleanup());
    const d = data(await v.call("search_regex", { vault: "test", pattern: "zebra" }));
    expect(paths(d)).toEqual(["a.md"]);
    expect(d.notes_read_refused).toBe(1);
  });

  it("search_jsonlogic returns the readable matches and counts the refusal", async () => {
    const v = makeM2Vault({ files: { "a.md": "zebra alpha\n", "n/b.md": "zebra beta\n" } });
    cleanups.push(() => v.cleanup());
    const d = data(
      await v.call("search_jsonlogic", { vault: "test", logic: { "!!": [{ var: "path" }] } }),
    );
    expect(paths(d)).toEqual(["a.md"]);
    expect(d.notes_read_refused).toBe(1);
  });

  it("search_vault text mode returns the readable hits and counts the refusal", async () => {
    const v = makeM2Vault({ files: { "a.md": "zebra alpha\n", "n/b.md": "zebra beta\n" } });
    cleanups.push(() => v.cleanup());
    const d = data(await v.call("search_vault", { vault: "test", query: "zebra", mode: "text" }));
    expect(paths(d)).toEqual(["a.md"]);
    expect(d.notes_read_refused).toBe(1);
  });

  it("a clean vault's search output carries no notes_read_refused key", async () => {
    const v = makeM2Vault({ files: { "a.md": "zebra alpha\n" } });
    cleanups.push(() => v.cleanup());
    const d = data(await v.call("search_text", { vault: "test", query: "zebra" }));
    expect("notes_read_refused" in d).toBe(false);
  });
});
