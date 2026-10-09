// Bridge-proxied rows are judged by what their path IS, not by what the plugin calls it.
//
// `wiki -> private` with readPaths ["wiki/**"]: read_note("wiki/secret.md") is refused (the ACL
// resolves the symlink; `private/secret.md` is outside the whitelist), but a companion-plugin row
// naming the display path `wiki/secret.md` passed the lexical whitelist and returned its excerpt.
// Every bridge tool that filters plugin rows (search_omnisearch, query_datacore, makemd_query,
// tasks_filter, resolve_daily_note) goes through vault/acl-read-filter.ts, which now resolves first.
//
// Positive control: `shared -> pages` where only `pages/**` is whitelisted still returns its rows.
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FakeRoute } from "../src/bridge";
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
        expect((await v.call("read_note", { vault: "test", path: "wiki/secret.md" })).ok).toBe(
          false,
        );
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
