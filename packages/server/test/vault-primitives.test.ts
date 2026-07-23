import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { issueElicitToken } from "../src/elicit";
import { argsHash } from "../src/hash";
import type { CallerContext } from "../src/mcp/registry";
import { enforcePathAcl } from "../src/vault/acl-path";
import { parseNote, serializeNote } from "../src/vault/frontmatter";
import { requireConfirmation } from "../src/vault/hitl";
import { buildVaultIndex, extractLinks, resolveTarget } from "../src/vault/links";
import {
  contentHash,
  normalizeVaultPath,
  resolveVaultPath,
  walkVault,
  walkVaultStream,
} from "../src/vault/paths";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

function freshDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}
function tmpVault(): string {
  return mkdtempSync(join(tmpdir(), "obtc-prim-"));
}

describe("paths: safety + content hash", () => {
  it("hashes content deterministically", () => {
    expect(contentHash("a")).toBe(contentHash("a"));
    expect(contentHash("a")).not.toBe(contentHash("b"));
    expect(contentHash("a")).toHaveLength(64);
  });
  it("normalizes and rejects traversal/absolute", () => {
    expect(normalizeVaultPath("a/./b.md")).toBe("a/b.md");
    expect(normalizeVaultPath("a\\b.md")).toBe("a/b.md");
    expect(() => normalizeVaultPath("../x")).toThrow();
    expect(() => normalizeVaultPath("/x")).toThrow();
  });
  it("rejects single-backslash and drive-letter absolute paths", () => {
    expect(() => normalizeVaultPath("\\windows\\system32")).toThrow(/absolute/i);
    expect(() => normalizeVaultPath("C:\\Users\\x")).toThrow(/absolute/i);
    expect(() => normalizeVaultPath("c:/Users/x")).toThrow(/absolute/i);
  });
  it("treats `..` as traversal only on a segment boundary (dotted filenames are fine)", () => {
    expect(() => normalizeVaultPath("a/../b")).toThrow(/traversal/i);
    expect(() => normalizeVaultPath("a\\..\\b")).toThrow(/traversal/i);
    expect(() => normalizeVaultPath("a/..")).toThrow(/traversal/i);
    // A leading-dot filename is not a traversal segment and must be allowed.
    expect(normalizeVaultPath("..gitkeep")).toBe("..gitkeep");
    expect(normalizeVaultPath("notes/v1.2..final.md")).toBe("notes/v1.2..final.md");
  });
  it("rejects Windows reserved device names, case-insensitively, with or without extension", () => {
    expect(() => normalizeVaultPath("CON")).toThrow(/reserved/i);
    expect(() => normalizeVaultPath("nul.md")).toThrow(/reserved/i);
    expect(() => normalizeVaultPath("notes/COM1/x.md")).toThrow(/reserved/i);
    expect(() => normalizeVaultPath("LPT9.txt")).toThrow(/reserved/i);
    // Names that merely start with a reserved stem are not reserved.
    expect(normalizeVaultPath("console.md")).toBe("console.md");
    expect(normalizeVaultPath("coms.md")).toBe("coms.md");
  });
  it("resolves within root and blocks escapes", () => {
    const root = tmpVault();
    try {
      const abs = resolveVaultPath(root, "notes/a.md");
      expect(abs.startsWith(root)).toBe(true);
      expect(() => resolveVaultPath(root, "../../etc/passwd")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("blocks escapes through an in-vault symlink (real-path containment)", () => {
    const base = mkdtempSync(join(tmpdir(), "obtc-link-"));
    const root = join(base, "vault");
    const outside = join(base, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.md"), "secret");
    let linked = false;
    try {
      symlinkSync(outside, join(root, "link"), "junction");
      linked = true;
    } catch {
      // symlink/junction creation may be unsupported on some hosts; skip the escape assertion
    }
    try {
      if (linked)
        expect(() => resolveVaultPath(root, "link/secret.md")).toThrow(/escapes the vault root/);
      expect(resolveVaultPath(root, "notes/a.md").startsWith(root)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  it("walks a vault, skipping dot-dirs", () => {
    const root = tmpVault();
    try {
      mkdirSync(join(root, "notes"));
      mkdirSync(join(root, ".obsidian"));
      writeFileSync(join(root, "notes", "a.md"), "x");
      writeFileSync(join(root, "b.md"), "y");
      writeFileSync(join(root, ".obsidian", "app.json"), "{}");
      writeFileSync(join(root, "img.png"), "p");
      const md = walkVault(root, { extensions: [".md"] }).map((e) => e.relPath);
      expect(md).toEqual(["b.md", "notes/a.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

// THE-490: walkVaultStream is the ADDITIVE, opt-in streaming counterpart to walkVault (used only
// by indexVault's `walk.streaming` option). It must visit the exact same SET of entries as
// walkVault (same skip rules, same extension/sub/includeFolders semantics) — callers that need
// walkVault's whole-tree sorted-array contract (16+ other call sites) keep using walkVault
// unchanged. It deliberately does NOT reproduce walkVault's whole-tree sort — see the "differs
// from a global sort" test below, which pins that difference so it can't silently regress into
// (or silently drift away from) a full accumulate-then-sort.
describe("paths: walkVaultStream (THE-490 streaming walk)", () => {
  it("yields the same SET of entries as walkVault, skipping dot-dirs", async () => {
    const root = tmpVault();
    try {
      mkdirSync(join(root, "notes"));
      mkdirSync(join(root, ".obsidian"));
      writeFileSync(join(root, "notes", "a.md"), "x");
      writeFileSync(join(root, "b.md"), "y");
      writeFileSync(join(root, ".obsidian", "app.json"), "{}");
      writeFileSync(join(root, "img.png"), "p");

      const array = walkVault(root, { extensions: [".md"] }).map((e) => e.relPath);
      const streamed = (await drain(walkVaultStream(root, { extensions: [".md"] }))).map(
        (e) => e.relPath,
      );
      expect(new Set(streamed)).toEqual(new Set(array));
      expect(streamed).toHaveLength(array.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("respects sub, extensions and includeFolders exactly like walkVault", async () => {
    const root = tmpVault();
    try {
      mkdirSync(join(root, "a", "b"), { recursive: true });
      writeFileSync(join(root, "a", "one.md"), "1");
      writeFileSync(join(root, "a", "b", "two.md"), "2");
      writeFileSync(join(root, "a", "b", "three.txt"), "3");

      const opts = { sub: "a", extensions: [".md"], includeFolders: true };
      const array = walkVault(root, opts);
      const streamed = await drain(walkVaultStream(root, opts));
      const sortByPath = (xs: typeof array) =>
        [...xs].sort((x, y) => x.relPath.localeCompare(y.relPath));
      expect(sortByPath(streamed)).toEqual(sortByPath(array));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not throw and yields nothing for a missing directory", async () => {
    const root = tmpVault();
    try {
      const streamed = await drain(walkVaultStream(join(root, "does-not-exist")));
      expect(streamed).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "sorts each directory's own children, but NOT the whole tree — a per-directory sort " +
      "can DISAGREE with walkVault's whole-relPath sort when a directory name is a prefix of a " +
      "sibling file name",
    async () => {
      const root = tmpVault();
      try {
        // Sibling "b" (a folder) and "b.md" (a file) at the root. Whole-relPath comparison of
        // "b.md" vs "b/x.md" hits '.' (0x2E) vs '/' (0x2F) at the 2nd char — '.' sorts first, so
        // walkVault's global sort puts the FILE "b.md" ahead of anything under the FOLDER "b".
        // A per-directory sort instead compares the two as plain sibling NAMES ("b" vs "b.md"),
        // where "b" is a strict prefix of "b.md" and therefore sorts first — so walkVaultStream
        // descends into "b/" (yielding "b/x.md") BEFORE it reaches the file "b.md": the exact
        // opposite order. This is the concrete case the module docs warn about; indexVault's
        // streaming option is safe ONLY because index output does not depend on this order (see
        // index-stream-walk-equivalence.test.ts, which flips this same knob and diffs DB state).
        mkdirSync(join(root, "b"));
        writeFileSync(join(root, "b", "x.md"), "1"); // relPath "b/x.md"
        writeFileSync(join(root, "b.md"), "2"); // relPath "b.md"

        const array = walkVault(root, { extensions: [".md"] }).map((e) => e.relPath);
        expect(array).toEqual(["b.md", "b/x.md"]);

        const streamed = (await drain(walkVaultStream(root, { extensions: [".md"] }))).map(
          (e) => e.relPath,
        );
        expect(streamed).toEqual(["b/x.md", "b.md"]);
        // Same SET either way — nothing is lost or duplicated, only the order differs.
        expect(new Set(streamed)).toEqual(new Set(array));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("VaultPath schema: byte-level traversal/absolute guard (shared)", () => {
  const ok = (p: string) => VaultPath.safeParse(p).success;
  it("rejects `..` only as a path segment, not as a substring", () => {
    expect(ok("../secret")).toBe(false);
    expect(ok("a/../b")).toBe(false);
    expect(ok("a\\..\\b")).toBe(false);
    expect(ok("a/..")).toBe(false);
    // dotted names containing ".." but no traversal segment are accepted (e.g. ..gitkeep)
    expect(ok("..gitkeep")).toBe(true);
    expect(ok("notes/v1.2..final.md")).toBe(true);
  });
  it("rejects POSIX, single-backslash, and drive-letter absolute paths", () => {
    expect(ok("/etc/passwd")).toBe(false);
    expect(ok("\\windows\\system32")).toBe(false);
    expect(ok("C:\\Users\\x")).toBe(false);
    expect(ok("c:/Users/x")).toBe(false);
    expect(ok("notes/a.md")).toBe(true);
  });
});

describe("frontmatter: parse + serialize", () => {
  it("parses frontmatter and preserves body verbatim", () => {
    const raw = "---\ntitle: Hi\ntags: [a, b]\n---\n# Body\n\nText with `code`.\n";
    const p = parseNote(raw);
    expect(p.hasFrontmatter).toBe(true);
    expect(p.frontmatter).toEqual({ title: "Hi", tags: ["a", "b"] });
    expect(p.body).toBe("# Body\n\nText with `code`.\n");
  });
  it("treats a note with no frontmatter as body-only", () => {
    const p = parseNote("# Just a body\n");
    expect(p.hasFrontmatter).toBe(false);
    expect(p.frontmatter).toBeNull();
    expect(p.body).toBe("# Just a body\n");
  });
  it("round-trips and keeps body bytes stable", () => {
    const p = parseNote("---\ntitle: A\n---\nBODY\n");
    const out = serializeNote({ ...p.frontmatter, added: 1 }, p.body);
    const reparsed = parseNote(out);
    expect(reparsed.frontmatter).toEqual({ title: "A", added: 1 });
    expect(reparsed.body).toBe("BODY\n");
  });
});

describe("links: extract + resolve", () => {
  it("extracts wikilinks, embeds, markdown links with code awareness", () => {
    const body =
      "See [[Note A]] and [[b/c#h|alias]] and ![[img.png]] and [ext](https://x).\n`[[not a link]]`\n";
    const links = extractLinks(body);
    const wiki = links.filter((l) => l.kind === "wikilink" && !l.inCodeblock);
    expect(wiki.map((l) => l.target)).toEqual(["Note A", "b/c"]);
    expect(wiki[1]?.display).toBe("alias");
    expect(wiki[1]?.heading).toBe("h");
    expect(links.some((l) => l.kind === "embed" && l.target === "img.png")).toBe(true);
    expect(links.some((l) => l.kind === "markdown" && l.target === "https://x")).toBe(true);
    expect(links.find((l) => l.raw.includes("not a link"))?.inCodeblock).toBe(true);
  });
  it("resolves exact path, basename, and flags ambiguity / unresolved", () => {
    const idx = buildVaultIndex(["Note A.md", "x/Dup.md", "y/Dup.md", "z/Solo.md"]);
    expect(resolveTarget(idx, "Note A").target_path).toBe("Note A.md");
    expect(resolveTarget(idx, "z/Solo").target_path).toBe("z/Solo.md");
    const dup = resolveTarget(idx, "Dup");
    expect(dup.resolved).toBe(true);
    expect(dup.candidates).toEqual(["x/Dup.md", "y/Dup.md"]);
    expect(resolveTarget(idx, "Missing").resolved).toBe(false);
    expect(resolveTarget(idx, "https://ext").resolved).toBe(false);
  });
});

describe("acl-path: per-path enforcement", () => {
  it("allows when whitelist omitted, denies outside it", () => {
    const open = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
    expect(() => enforcePathAcl(open, "write", "anywhere.md", tmpdir())).not.toThrow();
    const scoped = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      writePaths: ["notes/**"],
    });
    expect(() => enforcePathAcl(scoped, "write", "notes/a.md", tmpdir())).not.toThrow();
    expect(() => enforcePathAcl(scoped, "write", "secret.md", tmpdir())).toThrow(/whitelist/i);
  });
  it("blocks write/delete under read-only with read_only_mode", () => {
    const ro = new FolderAcl({ readOnly: true, defaultScopes: [], rules: [] });
    expect(() => enforcePathAcl(ro, "read", "a.md", tmpdir())).not.toThrow();
    try {
      enforcePathAcl(ro, "delete", "a.md", tmpdir());
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code: string }).code).toBe("read_only_mode");
    }
  });
});

describe("registry: resolve", () => {
  it("resolves default and named vaults; vault_not_found otherwise", () => {
    const reg = new VaultRegistry([
      { id: "main", path: "/tmp/main" },
      { id: "work", name: "Work", path: "/tmp/work" },
    ]);
    expect(reg.resolve().id).toBe("main");
    expect(reg.resolve("work").name).toBe("Work");
    try {
      reg.resolve("nope");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code: string }).code).toBe("vault_not_found");
    }
  });
});

describe("hitl: conditional confirmation", () => {
  it("passes when not needed; gates single-use when needed", () => {
    const db = freshDb();
    const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
      caller: "t",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "v1",
      db,
      ...over,
    });
    const input = { path: "a.md", mode: "overwrite" };
    expect(() => requireConfirmation(ctx(), "write_note", input, false)).not.toThrow();
    expect(() => requireConfirmation(ctx(), "write_note", input, true)).toThrow(/confirm/i);
    const token = issueElicitToken(db, {
      vaultId: "v1",
      toolName: "write_note",
      argsHash: argsHash("write_note", input),
      caller: "t",
    });
    expect(() =>
      requireConfirmation(ctx({ elicitToken: token }), "write_note", input, true),
    ).not.toThrow();
    // single-use: reuse fails
    expect(() =>
      requireConfirmation(ctx({ elicitToken: token }), "write_note", input, true),
    ).toThrow();
  });
});
