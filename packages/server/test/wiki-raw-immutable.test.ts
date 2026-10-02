// A vault's raw-sources folder is immutable: no write tool changes, creates, renames or deletes
// anything in it, however the path is spelled or reached (a symlink in, a symlink out), and a wiki
// commit that names it is refused whole. The rule is the folder ACL's own (acl.ts immutablePaths,
// built per vault in runtime/acl-build.ts), so every tool that already enforces the ACL enforces
// it; reads are untouched.
import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { contentHash } from "../src/vault/paths";
import { hashTree, makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

const CLIP = "# Clip\n\nA saved article about learning techniques.\n";
const FILES: Record<string, string> = {
  "wiki/SCHEMA.md": "---\ntypes:\n  concept:\n    required: [type]\nproperties:\n  type:\n---\n",
  "wiki/Page.md": "# Page\n\nBody.\n",
  "raw/clip.md": CLIP,
  "raw/deep/er/more.md": "More.\n",
  "sources/other.md": "Other.\n",
  "notes/free.md": "Free.\n",
};

let h: WikiHarness;
afterEach(() => h?.v.cleanup());

const harness = (opts: Parameters<typeof makeWikiHarness>[0] = {}): WikiHarness =>
  (h = makeWikiHarness({ files: FILES, wikiFolder: "wiki", ...opts }));

const code = (r: { ok: boolean; error?: { code?: string } }): string | undefined =>
  r.ok ? "ok" : r.error?.code;

describe("no write tool touches the raw folder", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["write_note (overwrite)", { path: "raw/clip.md", content: "x", mode: "overwrite" }],
    ["write_note (create)", { path: "raw/new.md", content: "x", mode: "create" }],
    ["write_note (nested)", { path: "raw/deep/er/new.md", content: "x" }],
    ["append_note", { path: "raw/clip.md", content: "more" }],
    [
      "patch_note",
      {
        path: "raw/clip.md",
        anchor: { type: "frontmatter" },
        operation: "append",
        content: "more",
      },
    ],
  ];
  for (const [tool, input] of cases) {
    it(`${tool} is refused and writes nothing`, async () => {
      harness();
      const before = hashTree(h.v.root);
      const name = tool.split(" ")[0] as string;
      const r = await h.call(name, input);
      expect(code(r)).toBe("acl_denied");
      expect(hashTree(h.v.root)).toEqual(before);
    });
  }

  it("delete_note is refused, trash or permanent, even with the confirmation in hand", async () => {
    harness();
    const before = hashTree(h.v.root);
    for (const permanent of [false, true]) {
      const args = { vault: "test", path: "raw/clip.md", permanent };
      const need = await h.v.call("delete_note", args);
      const token = issueElicitToken(h.v.db, {
        vaultId: "test",
        toolName: "delete_note",
        argsHash: String(need.ok ? "" : (need.error?.details as { args_hash?: string })?.args_hash),
        caller: "test",
      });
      const r = await h.v.call("delete_note", args, { elicitToken: token });
      expect(code(r)).toBe("acl_denied");
    }
    expect(hashTree(h.v.root)).toEqual(before);
  });

  it("move_note out of raw is refused (it deletes the source) and into raw is refused (it writes)", async () => {
    harness();
    const before = hashTree(h.v.root);
    expect(code(await h.call("move_note", { from: "raw/clip.md", to: "notes/clip.md" }))).toBe(
      "acl_denied",
    );
    expect(code(await h.call("move_note", { from: "notes/free.md", to: "raw/free.md" }))).toBe(
      "acl_denied",
    );
    expect(hashTree(h.v.root)).toEqual(before);
  });

  it("reads are untouched: the raw note reads, and a wiki note still writes", async () => {
    harness();
    const read = await h.call("read_note", { path: "raw/clip.md" });
    expect(read.ok).toBe(true);
    const w = await h.call("write_note", { path: "wiki/New.md", content: "ok", mode: "create" });
    expect(w.ok).toBe(true);
  });

  it("the error names the immutable folder, not a whitelist", async () => {
    harness();
    const r = await h.call("write_note", { path: "raw/clip.md", content: "x" });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toMatch(/immutable/);
  });

  it("a configured rawFolder is the one protected, and the default one is then free", async () => {
    harness({ rawFolder: "sources" });
    expect(code(await h.call("write_note", { path: "sources/other.md", content: "x" }))).toBe(
      "acl_denied",
    );
    expect(
      code(await h.call("write_note", { path: "raw/free.md", content: "x", mode: "create" })),
    ).toBe("ok");
  });

  it("a vault with no wiki folder has no raw folder: raw/ is an ordinary folder", async () => {
    h = makeWikiHarness({ files: FILES });
    const r = await h.call("write_note", { path: "raw/clip.md", content: "x", mode: "overwrite" });
    expect(code(r)).not.toBe("acl_denied");
  });
});

describe.skipIf(process.platform === "win32")(
  "aliases of the raw folder are still the raw folder",
  () => {
    const link = (target: string, at: string): void => {
      const abs = join(h.v.root, at);
      mkdirSync(dirname(abs), { recursive: true });
      symlinkSync(join(h.v.root, target), abs);
    };

    it("a symlink in the wiki that points at a raw note cannot write it", async () => {
      harness();
      link("raw/clip.md", "wiki/alias.md");
      const r = await h.call("write_note", {
        path: "wiki/alias.md",
        content: "x",
        mode: "overwrite",
      });
      expect(code(r)).toBe("acl_denied");
      expect(h.v.read("raw/clip.md")).toBe(CLIP);
    });

    it("a symlinked directory in the wiki that points at the raw folder cannot write into it", async () => {
      harness();
      link("raw", "wiki/rawlink");
      const r = await h.call("write_note", { path: "wiki/rawlink/new.md", content: "x" });
      expect(code(r)).toBe("acl_denied");
      expect(h.v.exists("raw/new.md")).toBe(false);
    });

    it("a symlink INSIDE raw that leads out does not make the path writable: it is still raw by name", async () => {
      harness();
      link("notes", "raw/out");
      const r = await h.call("write_note", { path: "raw/out/escape.md", content: "x" });
      expect(code(r)).toBe("acl_denied");
      expect(h.v.exists("notes/escape.md")).toBe(false);
    });
  },
);

describe("commit_wiki_page refuses anything that targets raw/", () => {
  const changeset = (over: Record<string, unknown>): Record<string, unknown> => ({
    topic: "Learning techniques",
    page: { path: "wiki/Learning techniques.md", frontmatter: { type: "concept" }, body: "# L\n" },
    patches: [],
    ...over,
  });

  it("a page whose path is in raw/", async () => {
    harness();
    const before = hashTree(h.v.root);
    const r = await h.call(
      "commit_wiki_page",
      changeset({ page: { path: "raw/Learning techniques.md", frontmatter: {}, body: "# L\n" } }),
    );
    expect(code(r)).toBe("acl_denied");
    expect(hashTree(h.v.root)).toEqual(before);
  });

  it("a patch on a raw note refuses the whole commit, so the page is not created either", async () => {
    harness();
    const before = hashTree(h.v.root);
    const r = await h.call(
      "commit_wiki_page",
      changeset({
        patches: [{ path: "raw/clip.md", prev_hash: contentHash(CLIP), operation: "link" }],
      }),
    );
    expect(code(r)).toBe("acl_denied");
    expect(hashTree(h.v.root)).toEqual(before);
  });

  it("a page that overwrites a raw note", async () => {
    harness();
    const before = hashTree(h.v.root);
    const r = await h.call(
      "commit_wiki_page",
      changeset({
        page: {
          path: "raw/clip.md",
          mode: "overwrite",
          prev_hash: contentHash(CLIP),
          frontmatter: {},
          body: "# L\n",
        },
      }),
    );
    expect(code(r)).toBe("acl_denied");
    expect(hashTree(h.v.root)).toEqual(before);
  });
});
