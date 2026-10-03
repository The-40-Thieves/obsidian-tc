// commit_wiki_page, the security review round: where a page may go (inside the configured wiki
// folder, judged lexically and after symlinks), read AND write ACL on every note that already
// exists (an unreadable note answers like a missing one and its hash never leaks), write-time
// compare-and-swap, one note one entry whatever its case, snapshot retention that waits for success,
// and a duplicate re-check made right before the write.
import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { contentHash } from "../src/vault/paths";
import { captureSnapshot, listSnapshots } from "../src/vault/snapshots";
import { hashTree, makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

const io = vi.hoisted(() => ({
  n: 0,
  failOn: 0,
  before: undefined as undefined | ((n: number) => void),
}));
vi.mock("../src/vault/notes-io", async (orig) => {
  const actual = await orig<typeof import("../src/vault/notes-io")>();
  return {
    ...actual,
    stageNoteWrite: (...a: Parameters<typeof actual.stageNoteWrite>) => {
      const s = actual.stageNoteWrite(...a);
      return {
        commit: () => {
          io.n++;
          io.before?.(io.n);
          if (io.failOn !== 0 && io.n === io.failOn) throw new Error("disk full");
          s.commit();
        },
        discard: () => s.discard(),
      };
    },
  };
});

const SCHEMA =
  "---\ntypes:\n  concept:\n    required: [type]\n    folder: concepts\nproperties:\n  type:\n---\n";
const FILES: Record<string, string> = {
  "wiki/SCHEMA.md": SCHEMA,
  "wiki/Related.md": "# Related\n\nAbout memory.\n",
  "wiki/Mentions.md": "Notes\n\nI rely on learning techniques.\n",
  "notes/Elsewhere.md": "Elsewhere\n",
  "journal/Daily.md": "Daily\n",
  "journal/Seen.md": "Seen\n",
};
const hash = (rel: string): string => contentHash(FILES[rel] as string);
const PAGE = "wiki/concepts/Learning techniques.md";

let h: WikiHarness;
beforeEach(() => {
  io.n = 0;
  io.failOn = 0;
  io.before = undefined;
});
afterEach(() => h?.v.cleanup());

function harness(opts: Parameters<typeof makeWikiHarness>[0] = {}): WikiHarness {
  h = makeWikiHarness({
    files: FILES,
    wikiFolder: "wiki",
    snapshots: { enabled: true, retention: 10 },
    ...opts,
  });
  return h;
}

function changeset(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topic: "Learning techniques",
    type: "concept",
    page: {
      path: PAGE,
      frontmatter: { type: "concept" },
      body: "# Learning techniques\n\nSee [[Related]].\n",
    },
    patches: [{ path: "wiki/Mentions.md", prev_hash: hash("wiki/Mentions.md"), operation: "link" }],
    ...over,
  };
}
const commit = (hh: WikiHarness, over?: Record<string, unknown>, ctx = {}): Promise<ToolResult> =>
  hh.v.call("commit_wiki_page", { vault: "test", ...changeset(over) }, ctx);
const errOf = (r: ToolResult): { code: string; message: string; details: Record<string, any> } => {
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.error as never;
};
const pageAt = (path: string, extra: Record<string, unknown> = {}) => ({
  page: { path, frontmatter: { type: "concept" }, body: "# x\n", ...extra },
});

describe("commit_wiki_page needs read:notes as well as write:notes", () => {
  // The duplicate re-check reads every ACL-visible note and names matching paths, and may send
  // candidate text to the judge: a write-only token must not be able to probe the vault with it.
  it("a token with write:notes only is refused, and nothing is written", async () => {
    const hh = harness();
    const before = hashTree(hh.v.root);
    const r = await commit(hh, {}, { grantedScopes: new Set(["write:notes"]) });
    expect(errOf(r).code).toBe("forbidden");
    expect(hashTree(hh.v.root)).toEqual(before);
  });

  it("a token with read:notes and write:notes commits", async () => {
    const hh = harness();
    const r = await commit(hh, {}, { grantedScopes: new Set(["read:notes", "write:notes"]) });
    expect(r.ok).toBe(true);
  });
});

describe("a page must be inside the configured wiki folder", () => {
  // Every one of these used to be created without a confirmation (the old test blessed it).
  for (const path of [
    "notes/Learning techniques.md",
    "Learning techniques.md",
    "wiki-evil/Learning techniques.md",
    "wikix.md",
    "journal/wiki/Learning techniques.md",
  ]) {
    it(`refuses a new page at ${path} and writes nothing`, async () => {
      const hh = harness();
      const before = hashTree(hh.v.root);
      const e = errOf(await commit(hh, { ...pageAt(path), patches: [] }));
      expect(e).toMatchObject({
        code: "invalid_input",
        details: { reason: "outside_wiki_folder" },
      });
      expect(hashTree(hh.v.root)).toEqual(before);
    });
  }

  // A case variant of the folder is in it exactly when the volume says it is the same directory.
  for (const path of ["Wiki/Learning techniques.md", "WIKI/concepts/Learning techniques.md"]) {
    it(`${path}: in the folder only if the filesystem says it is the folder`, async () => {
      const hh = harness();
      const sameDir = existsSync(join(hh.v.root, "WIKI"));
      const before = hashTree(hh.v.root);
      const r = await commit(hh, { ...pageAt(path), patches: [] });
      if (sameDir) return void expect(r.ok).toBe(true);
      expect(errOf(r)).toMatchObject({
        code: "invalid_input",
        details: { reason: "outside_wiki_folder" },
      });
      expect(hashTree(hh.v.root)).toEqual(before);
    });
  }

  // An NFC folder and an NFD request are one directory on APFS and two on Linux: the filesystem
  // decides, and where they differ the create would be outside the wiki with no confirmation.
  it("an NFC wiki folder and an NFD page path: in the folder only if the filesystem agrees", async () => {
    const nfc = "Caf\u00e9";
    const nfd = "Cafe\u0301";
    const hh = harness({
      files: { ...FILES, [`${nfc}/SCHEMA.md`]: SCHEMA },
      wikiFolder: nfc,
    });
    const sameDir = existsSync(join(hh.v.root, nfd));
    const before = hashTree(hh.v.root);
    const r = await commit(hh, { ...pageAt(`${nfd}/Learning techniques.md`), patches: [] });
    if (sameDir) return void expect(r.ok).toBe(true);
    expect(errOf(r)).toMatchObject({
      code: "invalid_input",
      details: { reason: "outside_wiki_folder" },
    });
    expect(hashTree(hh.v.root)).toEqual(before);
  });

  for (const path of [
    "wiki/../notes/Learning techniques.md",
    "../Learning techniques.md",
    "wiki/concepts/../../notes/x.md",
    "/etc/x.md",
  ]) {
    it(`refuses the traversal ${path}`, async () => {
      const hh = harness();
      const before = hashTree(hh.v.root);
      const e = errOf(await commit(hh, { ...pageAt(path), patches: [] }));
      expect(e.code).toBe("path_invalid");
      expect(hashTree(hh.v.root)).toEqual(before);
    });
  }

  it.skipIf(process.platform === "win32")(
    "refuses a page under a symlink inside the wiki folder that points out of it",
    async () => {
      const hh = harness();
      symlinkSync(join(hh.v.root, "notes"), join(hh.v.root, "wiki", "out"));
      const before = hashTree(hh.v.root);
      const e = errOf(
        await commit(hh, { ...pageAt("wiki/out/Learning techniques.md"), patches: [] }),
      );
      expect(e).toMatchObject({
        code: "invalid_input",
        details: { reason: "outside_wiki_folder" },
      });
      expect(existsSync(join(hh.v.root, "notes", "Learning techniques.md"))).toBe(false);
      expect(hashTree(hh.v.root)).toEqual(before);
    },
  );

  it("a vault with no wiki folder refuses every commit, naming the setting", async () => {
    const hh = harness({ wikiFolder: undefined });
    const before = hashTree(hh.v.root);
    const e = errOf(await commit(hh, { ...pageAt("Learning techniques.md"), patches: [] }));
    expect(e).toMatchObject({ code: "invalid_input", details: { reason: "no_wiki_folder" } });
    expect(e.message).toContain("wiki.folder");
    expect(hashTree(hh.v.root)).toEqual(before);
  });

  it("overwriting an existing note outside the wiki folder is refused too, confirmation or not", async () => {
    const hh = harness();
    const before = hashTree(hh.v.root);
    const e = errOf(
      await commit(hh, {
        ...pageAt("journal/Daily.md", { mode: "overwrite", prev_hash: hash("journal/Daily.md") }),
        patches: [],
      }),
    );
    expect(e).toMatchObject({ code: "invalid_input", details: { reason: "outside_wiki_folder" } });
    expect(hashTree(hh.v.root)).toEqual(before);
  });

  it("a page inside the folder (written with ./ and doubled slashes) is accepted", async () => {
    const hh = harness();
    const r = await commit(hh, { ...pageAt("./wiki//concepts/Learning techniques.md") });
    expect(r.ok).toBe(true);
    expect(hh.v.exists(PAGE)).toBe(true);
  });
});

describe("read ACL on every existing note the commit touches", () => {
  // wiki/Related.md is writable but NOT readable; everything else the commit needs is readable.
  const acl = {
    writePaths: ["wiki/**"],
    readPaths: ["wiki/Mentions.md", "wiki/SCHEMA.md", "wiki/concepts/**"],
  };
  const relatedHash = (): string => hash("wiki/Related.md");

  for (const centralAcl of [true, false]) {
    it(`a write-allowed, read-denied patch target is refused, leaks no hash and writes nothing (central ACL ${centralAcl})`, async () => {
      const hh = harness({ centralAcl, acl });
      const before = hashTree(hh.v.root);
      for (const prev of ["0".repeat(64), relatedHash()]) {
        const r = await commit(hh, {
          patches: [{ path: "wiki/Related.md", prev_hash: prev, operation: "link" }],
        });
        const e = errOf(r);
        expect(["acl_denied", "note_not_found"]).toContain(e.code);
        // The wrong guess must not be answered with the real hash, in any field of the error.
        expect(JSON.stringify(e)).not.toContain(relatedHash());
        expect(hashTree(hh.v.root)).toEqual(before);
      }
    });
  }

  it("without the central stage the handler answers exactly like a missing note", async () => {
    const hh = harness({ centralAcl: false, acl });
    const denied = errOf(
      await commit(hh, {
        patches: [{ path: "wiki/Related.md", prev_hash: "0".repeat(64), operation: "link" }],
      }),
    );
    const missing = errOf(
      await commit(hh, {
        patches: [{ path: "wiki/Ghost.md", prev_hash: "0".repeat(64), operation: "link" }],
      }),
    );
    expect(denied.code).toBe("note_not_found");
    expect(denied.code).toBe(missing.code);
    expect(denied.message).toBe(missing.message);
  });

  for (const centralAcl of [true, false]) {
    it(`overwriting a page the caller cannot read is refused with no hash leak (central ACL ${centralAcl})`, async () => {
      const hh = harness({ centralAcl, acl });
      const before = hashTree(hh.v.root);
      const e = errOf(
        await commit(hh, {
          topic: "Related",
          page: {
            path: "wiki/Related.md",
            mode: "overwrite",
            prev_hash: "0".repeat(64),
            body: "# New\n",
          },
          patches: [],
        }),
      );
      expect(["acl_denied", "note_not_found"]).toContain(e.code);
      expect(JSON.stringify(e)).not.toContain(relatedHash());
      expect(hashTree(hh.v.root)).toEqual(before);
    });
  }

  it("a readable and writable target still works under the same ACL", async () => {
    const hh = harness({ centralAcl: true, acl });
    const r = await commit(hh);
    expect(r.ok).toBe(true);
  });
});

describe("compare-and-swap at write time", () => {
  it("an external edit between the check and the rename aborts the batch and survives", async () => {
    const hh = harness();
    const before = hashTree(hh.v.root);
    // The page is renamed first; right after that, before the patch's own re-hash, someone edits it.
    io.before = (n) => {
      if (n === 1) hh.v.write("wiki/Mentions.md", "Notes\n\nEdited by hand meanwhile.\n");
    };
    const e = errOf(await commit(hh));
    expect(e.code).toBe("concurrent_modification");
    expect(e.details).toMatchObject({ path: "wiki/Mentions.md" });
    expect(hh.v.read("wiki/Mentions.md")).toBe("Notes\n\nEdited by hand meanwhile.\n");
    expect(hh.v.exists(PAGE)).toBe(false);
    expect(existsSync(join(hh.v.root, "wiki/concepts"))).toBe(false);
    const after = hashTree(hh.v.root);
    expect({ ...after, "wiki/Mentions.md": "" }).toEqual({ ...before, "wiki/Mentions.md": "" });
  });

  it("an external edit to a note the batch already replaced is not rolled back over", async () => {
    const hh = harness();
    io.before = (n) => {
      if (n === 3) {
        hh.v.write("wiki/Mentions.md", "someone rewrote the patched note\n");
        throw new Error("disk full");
      }
    };
    const e = errOf(
      await commit(hh, {
        patches: [
          { path: "wiki/Mentions.md", prev_hash: hash("wiki/Mentions.md"), operation: "link" },
          { path: "wiki/Related.md", prev_hash: hash("wiki/Related.md"), operation: "link" },
        ],
      }),
    );
    expect(e.code).toBe("internal_error");
    expect(e.details).toMatchObject({ changed_since_written: ["wiki/Mentions.md"] });
    expect(hh.v.read("wiki/Mentions.md")).toBe("someone rewrote the patched note\n");
    expect(hh.v.read("wiki/Related.md")).toBe(FILES["wiki/Related.md"]);
    expect(hh.v.exists(PAGE)).toBe(false);
  });

  it("a page recreated by someone else during the commit is never replaced or deleted", async () => {
    const hh = harness();
    io.before = (n) => {
      if (n === 1) hh.v.write(PAGE, "their page\n");
    };
    const e = errOf(await commit(hh));
    expect(e.code).toBe("note_exists");
    expect(hh.v.read(PAGE)).toBe("their page\n");
    expect(hh.v.read("wiki/Mentions.md")).toBe(FILES["wiki/Mentions.md"]);
  });
});

describe("one filesystem entry, one entry in a changeset", () => {
  it("two real files that differ only by case can both be patched on a case-sensitive volume", async (ctx) => {
    const upper = "Upper note\n";
    const lower = "Lower note\n";
    const hh = harness({
      files: { ...FILES, "wiki/Note.md": upper, "wiki/note.md": lower },
    });
    if (hh.v.read("wiki/Note.md") === hh.v.read("wiki/note.md")) {
      ctx.skip("case-insensitive volume aliases Note.md and note.md");
      return;
    }
    const r = await commit(hh, {
      patches: [
        { path: "wiki/Note.md", prev_hash: contentHash(upper), operation: "link" },
        { path: "wiki/note.md", prev_hash: contentHash(lower), operation: "link" },
      ],
    });
    expect(r.ok).toBe(true);
    expect(hh.v.read("wiki/Note.md")).toContain("[[Learning techniques]]");
    expect(hh.v.read("wiki/note.md")).toContain("[[Learning techniques]]");
  });

  it("a differently cased path with no filesystem identity is not conflated with the new page", async () => {
    const hh = harness();
    const e = errOf(
      await commit(hh, {
        patches: [
          { path: PAGE.toUpperCase().replace(/\.MD$/, ".md"), prev_hash: "x", operation: "link" },
        ],
      }),
    );
    expect(e.code).toBe("note_not_found");
  });

  it.skipIf(process.platform === "win32")(
    "a symlink alias of a patched note is the same entry",
    async () => {
      const hh = harness();
      symlinkSync(join(hh.v.root, "wiki", "Mentions.md"), join(hh.v.root, "wiki", "Alias.md"));
      const before = hashTree(hh.v.root);
      const e = errOf(
        await commit(hh, {
          patches: [
            { path: "wiki/Mentions.md", prev_hash: hash("wiki/Mentions.md"), operation: "link" },
            { path: "wiki/Alias.md", prev_hash: hash("wiki/Mentions.md"), operation: "link" },
          ],
        }),
      );
      expect(e.code).toBe("invalid_input");
      expect(hashTree(hh.v.root)).toEqual(before);
    },
  );
});

describe("snapshots", () => {
  const seed = (hh: WikiHarness): number | null =>
    captureSnapshot(
      hh.v.db,
      { enabled: true, retention: 1 },
      "test",
      "wiki/Mentions.md",
      "older\n",
      "seed",
    );

  it("a failed batch neither evicts an older recovery point nor leaves its own rows", async () => {
    const hh = harness({ snapshots: { enabled: true, retention: 1 } });
    const keep = seed(hh);
    io.failOn = 2;
    expect((await commit(hh)).ok).toBe(false);
    const rows = listSnapshots(hh.v.db, "test", "wiki/Mentions.md", 10);
    expect(rows.map((r) => r.id)).toEqual([keep]);
    expect(rows[0]?.op).toBe("seed");
  });

  it("an incomplete rollback keeps the snapshots: restore_note still recovers the pre-image", async () => {
    const hh = harness({ snapshots: { enabled: true, retention: 10 } });
    const patches = ["wiki/Mentions.md", "wiki/Related.md"].map((path) => ({
      path,
      prev_hash: hash(path),
      operation: "link",
    }));
    // The third rename fails; before it, someone edits Mentions.md, which this batch had already
    // replaced, so the rollback cannot (and must not) put its old text back over their edit.
    io.before = (n) => {
      if (n === 3) hh.v.write("wiki/Mentions.md", "their edit\n");
    };
    io.failOn = 3;
    const e = errOf(await commit(hh, { patches }));
    expect(e).toMatchObject({
      code: "internal_error",
      details: { changed_since_written: ["wiki/Mentions.md"] },
    });
    expect(hh.v.read("wiki/Mentions.md")).toBe("their edit\n");

    const rows = listSnapshots(hh.v.db, "test", "wiki/Mentions.md", 10);
    expect(rows).toHaveLength(1);
    const id = rows[0]?.id as number;
    const args = { vault: "test", path: "wiki/Mentions.md", snapshot_id: id };
    const need = await hh.v.call("restore_note", args);
    const token = issueElicitToken(hh.v.db, {
      vaultId: "test",
      toolName: "restore_note",
      argsHash: String((errOf(need).details as { args_hash?: string }).args_hash),
      caller: "test",
    });
    const restored = await hh.v.call("restore_note", args, { elicitToken: token });
    expect(restored.ok).toBe(true);
    expect(hh.v.read("wiki/Mentions.md")).toBe(FILES["wiki/Mentions.md"]);
  });

  it("a successful batch snapshots every replaced note first, then prunes to the retention", async () => {
    const hh = harness({ snapshots: { enabled: true, retention: 1 } });
    seed(hh);
    let atFirstRename = -1;
    io.before = (n) => {
      if (n === 1) atFirstRename = listSnapshots(hh.v.db, "test", "wiki/Related.md", 10).length;
    };
    const r = await commit(hh, {
      patches: [
        { path: "wiki/Mentions.md", prev_hash: hash("wiki/Mentions.md"), operation: "link" },
        { path: "wiki/Related.md", prev_hash: hash("wiki/Related.md"), operation: "link" },
      ],
    });
    expect(r.ok).toBe(true);
    // every touched existing note was saved before the first rename ...
    expect(atFirstRename).toBe(1);
    // ... and the prune ran only after success: one row left per note, the newest.
    const m = listSnapshots(hh.v.db, "test", "wiki/Mentions.md", 10);
    expect(m).toHaveLength(1);
    expect(m[0]?.op).toBe("commit_wiki_page");
    expect(listSnapshots(hh.v.db, "test", PAGE, 10)).toHaveLength(0);
  });
});

describe("the duplicate re-check right before the write", () => {
  it("a page that appears while the commit awaits the similarity check refuses the commit", async () => {
    let appeared = false;
    const hh = harness({
      onEmbed: () => {
        if (appeared) return;
        appeared = true;
        h.v.write("wiki/other/Learning techniques.md", "# Learning techniques\n\nsomeone else\n");
      },
    });
    const e = errOf(await commit(hh, { patches: [] }));
    expect(e).toMatchObject({ code: "conflict", details: { reason: "duplicate_page" } });
    expect(e.details.existing).toContain("wiki/other/Learning techniques.md");
    expect(hh.v.exists(PAGE)).toBe(false);
  });

  it("allow_duplicate still overrides it", async () => {
    let appeared = false;
    const hh = harness({
      onEmbed: () => {
        if (appeared) return;
        appeared = true;
        h.v.write("wiki/other/Learning techniques.md", "# Learning techniques\n\nsomeone else\n");
      },
    });
    const r = await commit(hh, { patches: [], allow_duplicate: true });
    expect(r.ok).toBe(true);
  });
});
