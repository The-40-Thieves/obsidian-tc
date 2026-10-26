// Platform-independent twin of read-refusal-walkers.test.ts: the safe open's refusal is simulated by
// throwing acl_denied from readNote for one note, so the walkers' skip-and-count path runs on every
// OS (the hard-link and symlink fixtures are POSIX-only). A separate file: the readNote mock below
// must not reach any other test's module graph.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findAttachmentReferences } from "../src/formats/attachments";
import { searchRegex, searchText } from "../src/search/text";
import { ReadRefusals } from "../src/tools/read-refusals";
import { makeM2Vault } from "./m2-helpers";
import { makeM3Vault } from "./m3-helpers";
import { itemPaths, okData } from "./read-refusal-helpers";

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

describe("a refused read is skipped and counted, not fatal", () => {
  it("findAttachmentReferences skips the refused note and counts it", () => {
    const v = makeM2Vault({ files: { "n/a.md": "![[img.png]]\n", "n/b.md": "![[img.png]]\n" } });
    cleanups.push(() => v.cleanup());
    const refusals = new ReadRefusals();
    expect(findAttachmentReferences(v.root, "img.png", refusals).map((e) => e.relPath)).toEqual([
      "n/a.md",
    ]);
    expect(refusals.count).toBe(1);
  });

  it("searchText and searchRegex skip the refused note and count it", async () => {
    const v = makeM2Vault({ files: { "n/a.md": "zebra n/a.md\n", "n/b.md": "zebra n/b.md\n" } });
    cleanups.push(() => v.cleanup());
    const refusals = new ReadRefusals();
    const text = searchText(v.root, { query: "zebra", limit: 100, refusals });
    expect(text.map((h) => h.path)).toEqual(["n/a.md"]);
    const regex = await searchRegex(v.root, { pattern: "zebra", limit: 100, refusals });
    expect(regex.map((h) => h.path)).toEqual(["n/a.md"]);
    expect(refusals.count).toBe(2);
  });

  it("list_attachments include_reference_count counts the readable reference and the refusal", async () => {
    const v = makeM3Vault({
      files: { "img.png": "png", "n/a.md": "![[img.png]]\n", "n/b.md": "![[img.png]]\n" },
    });
    cleanups.push(() => v.cleanup());
    const d = okData(
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
    const d = okData(await v.call("search_text", { vault: "test", query: "zebra" }));
    expect(itemPaths(d)).toEqual(["a.md"]);
    expect(d.notes_read_refused).toBe(1);
  });

  it("a clean vault's search output carries no notes_read_refused key", async () => {
    const v = makeM2Vault({ files: { "a.md": "zebra alpha\n" } });
    cleanups.push(() => v.cleanup());
    const d = okData(await v.call("search_text", { vault: "test", query: "zebra" }));
    expect("notes_read_refused" in d).toBe(false);
  });
});
