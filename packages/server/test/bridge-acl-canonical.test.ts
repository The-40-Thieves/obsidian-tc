// Bridge-proxied rows are judged by what their path IS, not by what the plugin calls it.
//
// `wiki -> private` with readPaths ["wiki/**"]: read_note("wiki/secret.md") is refused (the ACL
// resolves the symlink; `private/secret.md` is outside the whitelist), but a companion-plugin row
// naming the display path `wiki/secret.md` passed the lexical whitelist and returned its excerpt.
// Every bridge tool that filters plugin rows (search_omnisearch, query_datacore, makemd_query,
// tasks_filter, resolve_daily_note) goes through vault/acl-read-filter.ts, which now resolves first.
//
// Positive control: `shared -> pages` where only `pages/**` is whitelisted still returns its rows.
import { linkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FakeRoute } from "../src/bridge";
import { enforcePathAcl } from "../src/vault/acl-path";
import { filterBridgeItemsByAcl } from "../src/vault/acl-read-filter";
import { type M4Vault, makeM4Vault } from "./m4-helpers";

const MARK = "TOPSECRET";
const ACL = { readPaths: ["wiki/**", "pages/**", "pages"] };
const FILES: Record<string, string> = {
  "private/secret.md": `# secret\n${MARK}\n`,
  "pages/open.md": "# open\nopen text\n",
};

interface Family {
  tool: string;
  installed: string[];
  route: string;
  input: Record<string, unknown>;
  /** The plugin's response `result` for rows naming `path`. */
  result: (path: string, text: string) => unknown;
}

const FAMILIES: Family[] = [
  {
    tool: "search_omnisearch",
    installed: ["omnisearch"],
    route: "POST /obsidian-tc/v1/omnisearch/search",
    input: { query: "x" },
    result: (path, text) => ({ items: [{ path, excerpt: text }], total: 1 }),
  },
  {
    tool: "query_datacore",
    installed: ["datacore"],
    route: "POST /obsidian-tc/v1/datacore/query",
    input: { query: "@page" },
    result: (path, text) => ({ items: [{ path, excerpt: text }], total: 1 }),
  },
  {
    tool: "makemd_query",
    installed: ["make-md"],
    route: "POST /obsidian-tc/v1/makemd/query",
    input: { space_id: "s1" },
    result: (path, text) => ({ items: [{ note_path: path, excerpt: text }] }),
  },
  {
    tool: "tasks_filter",
    installed: ["tasks"],
    route: "POST /obsidian-tc/v1/tasks/filter",
    input: { filter: "done" },
    result: (path, text) => ({ items: [{ path, line: 1, text }] }),
  },
];

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const vault = (installed: string[], routes: Record<string, FakeRoute>): M4Vault => {
  const v = makeM4Vault({ files: FILES, acl: ACL, installed, routes });
  cleanups.push(v.cleanup);
  // wiki -> private (target denied), shared -> pages (target readable)
  symlinkSync(join(v.root, "private"), join(v.root, "wiki"));
  symlinkSync(join(v.root, "pages"), join(v.root, "shared"));
  return v;
};

/** read_note's path decision for `rel`: `enforcePathAcl("read")` (symlink-resolved target, hard-denied
 *  roots, hard-link refusal; every vault here has an ACL). The M4 test registry does not register
 *  read_note itself, and the fd reader behind it differs under the native addon. */
const readRefused = (v: M4Vault, rel: string): boolean => {
  try {
    enforcePathAcl(v.acl, "read", rel, v.root, ["*"]);
    return false;
  } catch {
    return true;
  }
};

const dump = (r: { ok: boolean; data?: unknown; error?: unknown }): string =>
  JSON.stringify(r.ok ? r.data : r.error);

describe.skipIf(process.platform === "win32")(
  "bridge rows are judged on the canonical target",
  () => {
    describe.each(FAMILIES)("$tool", (f) => {
      it("a row naming a denied target through the alias is dropped", async () => {
        const v = vault(f.installed, {
          [f.route]: { body: { ok: true, result: f.result("wiki/secret.md", MARK) } },
        });
        // the premise: the direct read of the same display path IS refused
        expect(readRefused(v, "wiki/secret.md")).toBe(true);
        const r = await v.call(f.tool, { vault: "test", ...f.input });
        expect(r.ok, dump(r)).toBe(true);
        expect(dump(r)).not.toContain(MARK);
        expect(dump(r)).not.toContain("wiki/secret.md");
      });

      it("a row naming a readable target through the alias is still returned", async () => {
        const v = vault(f.installed, {
          [f.route]: { body: { ok: true, result: f.result("shared/open.md", "open text") } },
        });
        const r = await v.call(f.tool, { vault: "test", ...f.input });
        expect(r.ok, dump(r)).toBe(true);
        expect(dump(r)).toContain("shared/open.md");
      });
    });

    describe("resolve_daily_note", () => {
      const daily = (path: string) =>
        vault([], {
          "POST /obsidian-tc/v1/daily-notes/resolve": {
            body: { ok: true, result: { path, exists: true } },
          },
        });

      it("is refused when the resolved path is a denied target behind an alias", async () => {
        const v = daily("wiki/secret.md");
        const r = await v.call("resolve_daily_note", { vault: "test" });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("acl_denied");
      });

      it("resolves a readable target behind an alias", async () => {
        const v = daily("shared/open.md");
        const r = await v.call("resolve_daily_note", { vault: "test" });
        expect(r.ok, dump(r)).toBe(true);
      });
    });

    // read_note refuses a hard-linked file (inode aliasing: realpath cannot dereference a hard
    // link, so a pathname check alone admits `allowed/hard.md` for a file living in `private/`).
    describe.each(FAMILIES)("$tool: hard link", (f) => {
      it("a row naming a hard link to a denied file is dropped, as read_note refuses it", async () => {
        const v = vault(f.installed, {
          [f.route]: { body: { ok: true, result: f.result("pages/hard.md", MARK) } },
        });
        linkSync(join(v.root, "private", "secret.md"), join(v.root, "pages", "hard.md"));
        expect(readRefused(v, "pages/hard.md")).toBe(true);
        const r = await v.call(f.tool, { vault: "test", ...f.input });
        expect(r.ok, dump(r)).toBe(true);
        expect(dump(r)).not.toContain(MARK);
        expect(dump(r)).not.toContain("pages/hard.md");
      });
    });

    // Default ACL (readPaths omitted, strict off): enumeration is "unrestricted", yet read_note
    // still hard-denies the canonical .obsidian / .git / .trash.
    describe.each(FAMILIES)("$tool: default ACL, alias into a hard-denied folder", (f) => {
      it.each([".obsidian", ".git", ".trash"])("alias -> %s is dropped", async (dir) => {
        const v = makeM4Vault({
          files: { [`${dir}/plugins/foo/data.md`]: `${MARK}\n`, "pages/open.md": "open text\n" },
          acl: {},
          installed: f.installed,
          routes: {
            [f.route]: {
              body: {
                ok: true,
                result: f.result("alias/plugins/foo/data.md", "CONFIGSECRET"),
              },
            },
          },
        });
        cleanups.push(v.cleanup);
        symlinkSync(join(v.root, dir), join(v.root, "alias"));
        expect(readRefused(v, "alias/plugins/foo/data.md")).toBe(true);
        const r = await v.call(f.tool, { vault: "test", ...f.input });
        expect(r.ok, dump(r)).toBe(true);
        expect(dump(r)).not.toContain("CONFIGSECRET");
        expect(dump(r)).not.toContain("alias/plugins");
      });

      it("an ordinary row is still returned untouched", async () => {
        const v = makeM4Vault({
          files: { "pages/open.md": "open text\n" },
          acl: {},
          installed: f.installed,
          routes: {
            [f.route]: { body: { ok: true, result: f.result("pages/open.md", "open text") } },
          },
        });
        cleanups.push(v.cleanup);
        const r = await v.call(f.tool, { vault: "test", ...f.input });
        expect(r.ok, dump(r)).toBe(true);
        expect(dump(r)).toContain("pages/open.md");
      });
    });

    it("filter decision == read_note decision (hard link, hard-denied alias, readable alias)", async () => {
      const v = vault(["tasks"], {});
      linkSync(join(v.root, "private", "secret.md"), join(v.root, "pages", "hard.md"));
      const paths = ["pages/hard.md", "wiki/secret.md", "shared/open.md", "pages/open.md"];
      for (const p of paths) {
        const read = !readRefused(v, p);
        const kept = filterBridgeItemsByAcl(v.acl, v.root, ["*"], [{ path: p }], {
          tool: "t",
        });
        expect(kept.length === 1, p).toBe(read);
      }
    });

    it("assertBridgePathReadable refuses a hard-linked daily note", async () => {
      const v = vault([], {
        "POST /obsidian-tc/v1/daily-notes/resolve": {
          body: { ok: true, result: { path: "pages/hard.md", exists: true } },
        },
      });
      linkSync(join(v.root, "private", "secret.md"), join(v.root, "pages", "hard.md"));
      const r = await v.call("resolve_daily_note", { vault: "test" });
      expect(r.ok).toBe(false);
    });

    it("an unresolvable row (path escaping the vault through a link) fails closed", async () => {
      const v = vault(["tasks"], {});
      symlinkSync("/etc", join(v.root, "pages", "out"));
      const rows = [{ path: "pages/out/passwd" }, { path: "pages/open.md" }];
      const kept = filterBridgeItemsByAcl(v.acl, v.root, new Set(["read:notes"]), rows, {
        tool: "tasks_filter",
      });
      expect(kept).toEqual([{ path: "pages/open.md" }]);
    });
  },
);
