// Enumeration judges a symlinked folder by what it IS, not by what it is called.
//
// `wiki -> private` with readPaths ["wiki/**"]: read_note("wiki/secret-project.md") is refused (the
// ACL resolves the symlink, `private/secret-project.md` is outside the whitelist), but every walker
// listed the same file under its lexical name `wiki/secret-project.md`, which the whitelist allows,
// and so named it with its size and mtime. The fix is at the walker boundary: each entry carries the
// canonical `aclRel`, and every consumer filters on it (vault/acl-read-filter.ts `readableEntry`).
//
// Positive control: `shared -> pages` where only `pages/**` is whitelisted still lists, under its
// display path `shared/...`, because the target is readable.
import { statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/types";
import { listResources } from "../src/mcp/resources";
import { readableByFolder, readableEntry, readableResolved } from "../src/vault/acl-read-filter";
import { nativeVaultIo } from "../src/vault/notes-io";
import { walkVault, walkVaultStream } from "../src/vault/paths";
import { makeTestVault } from "./m1-helpers";
import { makeM2Vault } from "./m2-helpers";
import { makeM3Vault } from "./m3-helpers";
import { makeM4Vault } from "./m4-helpers";

const SECRET = "secret-project";
const MARK = "TOPSECRETMARK";
// Whitelist form of the repro: `wiki/**` is allowed, the alias target `private` is not.
const ACL = { readPaths: ["wiki/**", "pages/**", "pages"] };
// Rule-scope form: the folder itself passes (so a tool that checks its `folder` argument lets the
// listing start), while `private/**` needs a scope the caller lacks. The alias name matches no rule.
const ACL_SCOPED = { rules: [{ glob: "private/**", scopes: ["read:private"] }] };
// index_vault checks only its `folder` argument and then the folder whitelist per walked note: the
// exact entry `private` lets the alias folder itself start, while `private/<note>` is not whitelisted.
const ACL_INDEX = { readPaths: ["wiki/**", "private", "pages", "pages/**"] };
const CALLER = { grantedScopes: new Set(["read:notes", "read:attachments"]) };
const ADMIN = { grantedScopes: new Set(["read:notes", "admin:vault"]) };
const BOARD = (card: string): string =>
  `---\nkanban-plugin: board\ntags: [leaktag]\n---\n\n## Todo\n\n- [ ] ${card}\n\n## Done\n\n`;
const FILES: Record<string, string> = {
  [`private/${SECRET}.md`]: BOARD(MARK),
  "private/pic.png": MARK,
  "pages/open-note.md": BOARD("open card"),
  "pages/open.png": "open image",
};

/** `wiki -> private` (denied by the whitelist) and `shared -> pages` (readable target). */
const alias = (root: string): void => {
  symlinkSync(join(root, "private"), join(root, "wiki"));
  symlinkSync(join(root, "pages"), join(root, "shared"));
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const m1 = (opts: { pinned: boolean }) => {
  const v = makeTestVault({
    files: FILES,
    acl: ACL,
    ...(opts.pinned ? { wikiFolder: "wiki", centralAcl: true } : {}),
    setup: alias,
  });
  cleanups.push(v.cleanup);
  return v;
};
const m2 = (acl: object = ACL_SCOPED) => {
  const v = makeM2Vault({ files: FILES, acl });
  cleanups.push(v.cleanup);
  alias(v.root);
  return v;
};
const m4 = () => {
  const v = makeM4Vault({ files: FILES, acl: ACL });
  cleanups.push(v.cleanup);
  alias(v.root);
  return v;
};
const m3 = (acl: object = ACL) => {
  const v = makeM3Vault({ files: FILES, acl });
  cleanups.push(v.cleanup);
  alias(v.root);
  return v;
};

const dump = (r: { ok: boolean; data?: unknown; error?: unknown }): string =>
  JSON.stringify(r.ok ? r.data : r.error);
const leaks = (s: string): boolean => s.includes(SECRET) || s.includes(MARK);

describe.skipIf(process.platform === "win32")("enumeration filters on the canonical target", () => {
  describe.each([
    ["configured (pinned) folder", true],
    ["unconfigured symlink", false],
  ])("list_notes: %s", (_label, pinned) => {
    it("names, sizes and mtimes of a denied target do not appear", async () => {
      const v = m1({ pinned });
      const direct = await v.call("read_note", { vault: "test", path: `wiki/${SECRET}.md` });
      expect(direct.ok).toBe(false); // the premise: the direct read IS denied
      const r = await v.call("list_notes", { vault: "test", folder: "wiki" });
      expect(r.ok).toBe(true);
      expect(leaks(dump(r))).toBe(false);
      if (r.ok) expect((r.data as { notes: unknown[] }).notes).toEqual([]);
    });

    it("a readable target still lists, under its display path, with its size and mtime", async () => {
      const v = m1({ pinned });
      const r = await v.call("list_notes", { vault: "test", folder: "shared" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const st = statSync(join(v.root, "pages", "open-note.md"));
      expect((r.data as { notes: unknown[] }).notes).toEqual([
        { path: "shared/open-note.md", size: st.size, mtime: st.mtimeMs },
      ]);
    });
  });

  it("list_notes: a plain (non-aliased) listing is unchanged", async () => {
    const v = m1({ pinned: false });
    const r = await v.call("list_notes", { vault: "test", folder: "pages" });
    expect(r.ok && (r.data as { notes: Array<{ path: string }> }).notes.map((n) => n.path)).toEqual(
      ["pages/open-note.md"],
    );
  });

  it("list_tags and find_notes_by_tag do not count or name a denied target", async () => {
    const v = m1({ pinned: false });
    const tags = await v.call("list_tags", { vault: "test", folder: "wiki" });
    expect(tags.ok).toBe(true);
    expect(leaks(dump(tags)) || dump(tags).includes("leaktag")).toBe(false);
    const found = await v.call("find_notes_by_tag", {
      vault: "test",
      tag: "leaktag",
      folder: "wiki",
    });
    expect(leaks(dump(found))).toBe(false);
    const ok = await v.call("find_notes_by_tag", {
      vault: "test",
      tag: "leaktag",
      folder: "shared",
    });
    expect(dump(ok)).toContain("shared/open-note.md");
  });

  it("a configured folder whose target is readable still counts its tags, under the display path", async () => {
    const v = makeTestVault({
      files: FILES,
      acl: { readPaths: ["pages", "pages/**"] },
      wikiFolder: "wiki",
      centralAcl: true,
      setup: (root) => symlinkSync(join(root, "pages"), join(root, "wiki")),
    });
    cleanups.push(v.cleanup);
    const tags = await v.call("list_tags", { vault: "test", folder: "wiki" });
    if (!nativeVaultIo) {
      // Without the native module a configured symlinked folder is refused outright.
      expect(tags.ok).toBe(false);
      return;
    }
    expect(tags.ok && (tags.data as { tags: unknown[] }).tags).toEqual([
      { tag: "leaktag", count: 1 },
    ]);
    const found = await v.call("find_notes_by_tag", {
      vault: "test",
      tag: "leaktag",
      folder: "wiki",
    });
    expect(dump(found)).toContain("wiki/open-note.md");
  });

  it("list_kanban_boards names no denied board and still lists a readable one", async () => {
    const v = m3();
    const denied = await v.call("list_kanban_boards", { vault: "test", folder: "wiki" });
    expect(leaks(dump(denied))).toBe(false);
    const ok = await v.call("list_kanban_boards", { vault: "test", folder: "shared" });
    expect(dump(ok)).toContain("shared/open-note.md");
  });

  it("list_attachments shows no denied file's name, size or mtime and still lists a readable one", async () => {
    const v = m3(ACL_SCOPED);
    const denied = await v.call("list_attachments", { vault: "test", folder: "wiki" }, CALLER);
    expect(denied.ok).toBe(true);
    expect(dump(denied)).not.toContain("pic.png");
    const ok = await v.call("list_attachments", { vault: "test", folder: "shared" }, CALLER);
    expect(dump(ok)).toContain("shared/open.png");
  });

  it("search_regex and search_text read no denied target through the alias", async () => {
    const v = m2();
    for (const [tool, input] of [
      ["search_regex", { pattern: MARK }],
      ["search_text", { query: MARK }],
    ] as const) {
      const denied = await v.call(tool, { vault: "test", root: "wiki", ...input }, CALLER);
      expect(leaks(dump(denied))).toBe(false);
      if (denied.ok) expect((denied.data as { hits?: unknown[] }).hits ?? []).toEqual([]);
    }
    // Native safe-open refuses an UNCONFIGURED symlinked folder on read (fail closed, as on main), so
    // the readable-alias positive control only has a result to show on the JS fallback; the pinned
    // positive control for a content-reading tool is the list_tags case above.
    if (!nativeVaultIo) {
      const ok = await v.call(
        "search_text",
        { vault: "test", root: "shared", query: "open card" },
        CALLER,
      );
      expect(dump(ok)).toContain("shared/open-note.md");
    }
  });

  it("search_jsonlogic filters the alias on its target", async () => {
    const v = m2();
    const denied = await v.call(
      "search_jsonlogic",
      { vault: "test", root: "wiki", logic: { in: ["leaktag", { var: "tags" }] } },
      CALLER,
    );
    expect(leaks(dump(denied))).toBe(false);
  });

  it("list_tasks reads no denied target, by folder or by an explicitly named alias path", async () => {
    const v = m4();
    const tasks = { grantedScopes: new Set(["read:tasks"]) };
    // Named paths: the lexical alias passes the whitelist, its target does not.
    const named = await v.call(
      "list_tasks",
      { vault: "test", paths: [`wiki/${SECRET}.md`] },
      tasks,
    );
    expect(leaks(dump(named))).toBe(false);
    if (named.ok) expect((named.data as { items: unknown[] }).items).toEqual([]);
  });

  it("readableResolved judges an alias by its target and fails closed on a path it cannot resolve", () => {
    const v = m1({ pinned: false });
    const ok = (rel: string): boolean => readableResolved(v.acl, v.root, rel, ["*"]);
    expect(ok(`wiki/${SECRET}.md`)).toBe(false);
    expect(ok("pages/open-note.md")).toBe(true);
    expect(ok("../outside.md")).toBe(false);
  });

  it("the walkers carry the canonical aclRel next to the display path", async () => {
    const v = m1({ pinned: false });
    const sync = walkVault(v.root, { sub: "wiki", extensions: [".md"] });
    expect(sync.map((e) => [e.relPath, e.aclRel])).toEqual([
      [`wiki/${SECRET}.md`, `private/${SECRET}.md`],
    ]);
    const streamed: Array<[string, string]> = [];
    for await (const e of walkVaultStream(v.root, { sub: "wiki", extensions: [".md"] }))
      streamed.push([e.relPath, e.aclRel]);
    expect(streamed).toEqual([[`wiki/${SECRET}.md`, `private/${SECRET}.md`]]);
    // A plain walk: display path and identity agree.
    for (const e of walkVault(v.root, { extensions: [".md"] })) expect(e.aclRel).toBe(e.relPath);
    // And the shared filter reads the identity, not the name.
    const [e] = sync;
    expect(e).toBeDefined();
    if (e) {
      expect(readableByFolder(v.acl, e.relPath)).toBe(true); // the lexical name passes the whitelist
      expect(readableEntry(v.acl, e, ["*"])).toBe(false); // the target does not
    }
  });

  it("resources/list names no denied target and keeps a readable one", () => {
    const v = m1({ pinned: false });
    const ctx = v.ctx();
    const names = listResources(v.vaultRegistry, ctx, () => v.acl).resources.map((r) => r.name);
    // A root walk never descends a symlink, so aliases are not listed at all; nothing leaks.
    expect(names.some((n) => n.includes(SECRET))).toBe(false);
    expect(names).toContain("pages/open-note.md");
  });
});

describe.skipIf(process.platform === "win32")(
  "index candidates are judged on the canonical target",
  () => {
    it("index_vault of an alias folder does not index a denied target", async () => {
      const v = m2(ACL_INDEX);
      const r = await v.call("index_vault", { vault: "test", folder: "wiki" }, ADMIN);
      const rows = (db: Database): unknown[] =>
        db.prepare("SELECT path FROM chunks WHERE vault_id = ?").all("test");
      expect(rows(v.db)).toEqual([]);
      expect(leaks(dump(r))).toBe(false);
      // The readable alias is indexed under its display path.
      if (!nativeVaultIo) {
        await v.call("index_vault", { vault: "test", folder: "shared" }, ADMIN);
        expect(JSON.stringify(rows(v.db))).toContain("shared/open-note.md");
      }
    });
  },
);

// The source-scan guard that lived here (a count of files with walker calls, and a grep for
// `readableRel(...relPath`) is retired: it passed every shape where the display path reached the
// predicate by another road (an alias, a destructure, a wrapper, a callback, a DB row). The CI lint
// job runs `bun run check:acl-identity` (scripts/check-acl-canonical-identity.mjs), an AST data-flow
// scan with existence floors, in its place.
