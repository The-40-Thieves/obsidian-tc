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
  result: (path: string, text: string) => Record<string, unknown>;
}

interface UnrestrictedBridgeFamily {
  tool: "git_status" | "list_templates";
  installed: string[];
  route: string;
  input: Record<string, unknown>;
  result: (path: string, text: string) => Record<string, unknown>;
}

interface GitProjectionCase {
  tool: "git_diff" | "git_log" | "git_stage" | "git_commit";
  route: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  expectedKeys: string[];
  confirmed?: boolean;
}

interface CompanionProjectionCase {
  tool: string;
  route: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  installed?: string[];
  files?: Record<string, string>;
  confirmed?: boolean;
  commandPolicy?: (vaultId: string) => { enabled: boolean; allowlist: string[] };
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

const UNRESTRICTED_PATH_FAMILIES: UnrestrictedBridgeFamily[] = [
  {
    tool: "git_status",
    installed: ["git"],
    route: "POST /obsidian-tc/v1/git/status",
    input: {},
    result: (path, text) => ({
      paths_relative_to_vault: true,
      changed: [{ path, working_dir: text, index: "" }],
      staged: [{ path, index: text }],
      conflicted: [path],
    }),
  },
  {
    tool: "list_templates",
    installed: ["templater"],
    route: "POST /obsidian-tc/v1/templater/list",
    input: {},
    result: (path, text) => ({ items: [{ path, name: "template", parsed_body: text }] }),
  },
];

const ITEM_LIST_FAMILIES = [
  ...FAMILIES,
  {
    tool: "list_templates",
    installed: ["templater"],
    route: "POST /obsidian-tc/v1/templater/list",
    input: {},
  },
];

const GIT_PROJECTION_CASES: GitProjectionCase[] = [
  {
    tool: "git_diff",
    route: "POST /obsidian-tc/v1/git/diff",
    input: { path: "pages/open.md" },
    result: { diff: "+open", hits: [{ path: ".trash/secret.md", excerpt: "TOPSECRET" }] },
    expectedKeys: ["diff", "path", "staged", "vault"],
  },
  {
    tool: "git_log",
    route: "POST /obsidian-tc/v1/git/log",
    input: {},
    result: { entries: [], hits: [{ path: ".trash/secret.md", excerpt: "TOPSECRET" }] },
    expectedKeys: ["entries", "vault"],
  },
  {
    tool: "git_stage",
    route: "POST /obsidian-tc/v1/git/stage",
    input: { paths: ["pages/open.md"] },
    result: { staged: 1, hits: [{ path: ".trash/secret.md", excerpt: "TOPSECRET" }] },
    expectedKeys: ["staged", "vault"],
  },
  {
    tool: "git_commit",
    route: "POST /obsidian-tc/v1/git/commit",
    input: { message: "snapshot" },
    result: {
      committed: 1,
      fired_at: "2026-10-15T00:00:00.000Z",
      hits: [{ path: ".trash/secret.md", excerpt: "TOPSECRET" }],
    },
    expectedKeys: ["committed", "fired_at", "vault"],
    confirmed: true,
  },
];

const INCIDENT = { path: ".trash/secret.md", excerpt: "TOPSECRET" };
const COMPANION_PROJECTION_CASES: CompanionProjectionCase[] = [
  {
    tool: "makemd_list_spaces",
    route: "POST /obsidian-tc/v1/makemd/spaces",
    input: {},
    result: { spaces: [], hits: [INCIDENT] },
    installed: ["make-md"],
  },
  {
    tool: "list_commands",
    route: "POST /obsidian-tc/v1/commands/list",
    input: {},
    result: { items: [{ id: "app:open", name: "Open" }], total: 1, hits: [INCIDENT] },
  },
  {
    tool: "execute_command",
    route: "POST /obsidian-tc/v1/commands/execute",
    input: { command_id: "app:open" },
    result: { command_id: "app:open", fired_at: "2026-10-15T00:00:00.000Z", hits: [INCIDENT] },
    confirmed: true,
    commandPolicy: () => ({ enabled: true, allowlist: ["app:open"] }),
  },
  {
    tool: "list_quickadd_actions",
    route: "POST /obsidian-tc/v1/quickadd/actions",
    input: {},
    result: { items: [{ name: "Capture", type: "template" }], hits: [INCIDENT] },
    installed: ["quickadd"],
  },
  {
    tool: "trigger_quickadd",
    route: "POST /obsidian-tc/v1/quickadd/trigger",
    input: { action_name: "Capture" },
    result: { action_name: "Capture", fired_at: "2026-10-15T00:00:00.000Z", hits: [INCIDENT] },
    installed: ["quickadd"],
    confirmed: true,
  },
  {
    tool: "validate_dql",
    route: "POST /obsidian-tc/v1/dataview/validate",
    input: { dql: "LIST" },
    result: { valid: true, hits: [INCIDENT] },
    installed: ["dataview"],
  },
  {
    tool: "eval_dataview_field",
    route: "POST /obsidian-tc/v1/dataview/eval",
    input: { path: "pages/open.md", expression: "file.name" },
    result: { value: "open", type: "string", hits: [INCIDENT] },
    installed: ["dataview"],
  },
  {
    tool: "read_metadata_fields",
    route: "POST /obsidian-tc/v1/metadata-menu/fields",
    input: { path: "pages/open.md" },
    result: { path: "pages/open.md", fields: {}, total: 0, hits: [INCIDENT] },
    installed: ["metadata-menu"],
  },
  {
    tool: "ocr_attachment",
    route: "POST /obsidian-tc/v1/ocr/attachment",
    input: { path: "Attach/scan.png" },
    result: {
      path: "Attach/scan.png",
      text: "open",
      cached: false,
      duration_ms: 1,
      hits: [INCIDENT],
    },
    installed: ["text-extractor"],
    files: { "Attach/scan.png": "binary" },
  },
  {
    tool: "ocr_bulk",
    route: "POST /obsidian-tc/v1/ocr/bulk",
    input: { paths: ["Attach/scan.png"] },
    result: {
      processed: 1,
      results: [{ path: "Attach/scan.png", ok: true, text: "open" }],
      total_duration_ms: 1,
      hits: [INCIDENT],
    },
    installed: ["text-extractor"],
    confirmed: true,
  },
  {
    tool: "read_excalidraw",
    route: "POST /obsidian-tc/v1/excalidraw/read",
    input: { path: "Drawings/open.excalidraw" },
    result: { path: "Drawings/open.excalidraw", text_content: "open", hits: [INCIDENT] },
    installed: ["excalidraw"],
  },
  {
    tool: "create_excalidraw",
    route: "POST /obsidian-tc/v1/excalidraw/write",
    input: { path: "Drawings/new.excalidraw" },
    result: { path: "Drawings/new.excalidraw", plugin_used: true, hits: [INCIDENT] },
    installed: ["excalidraw"],
  },
  {
    tool: "update_excalidraw",
    route: "POST /obsidian-tc/v1/excalidraw/write",
    input: { path: "Drawings/open.excalidraw", add_elements: [] },
    result: {
      path: "Drawings/open.excalidraw",
      plugin_used: true,
      unchanged: true,
      hits: [INCIDENT],
    },
    installed: ["excalidraw"],
  },
  {
    tool: "remotely_save_status",
    route: "POST /obsidian-tc/v1/remotely-save/status",
    input: {},
    result: { sync_status: "idle", last_success_sync: null, hits: [INCIDENT] },
    installed: ["remotely-save"],
  },
  {
    tool: "remotely_save_trigger",
    route: "POST /obsidian-tc/v1/remotely-save/trigger",
    input: {},
    result: { triggered: true, fired_at: "2026-10-15T00:00:00.000Z", hits: [INCIDENT] },
    installed: ["remotely-save"],
  },
  {
    tool: "execute_template",
    route: "POST /obsidian-tc/v1/templater/execute",
    input: { template: "Templates/daily.md", target: "Daily/2026-10-15.md" },
    result: {
      template: "Templates/daily.md",
      target: "pages/open.md",
      created_at: "2026-10-15T00:00:00.000Z",
      hits: [INCIDENT],
    },
    installed: ["templater"],
    confirmed: true,
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
    describe.each(UNRESTRICTED_PATH_FAMILIES)("$tool: unrestricted bridge paths", (f) => {
      const call = (v: M4Vault) => v.call(f.tool, { vault: "test", ...f.input });

      it("drops a hard-linked row without refusing the whole capability", async () => {
        const v = makeM4Vault({
          files: {
            "private/secret.md": MARK,
            "pages/open.md": "open text",
            "templates/ok.md": "open text",
          },
          acl: {},
          installed: f.installed,
          routes: { [f.route]: { body: { ok: true, result: f.result("pages/hard.md", MARK) } } },
        });
        cleanups.push(v.cleanup);
        linkSync(join(v.root, "private", "secret.md"), join(v.root, "pages", "hard.md"));
        expect(readRefused(v, "pages/hard.md")).toBe(true);

        const r = await call(v);
        expect(r.ok, dump(r)).toBe(true);
        expect(dump(r)).not.toContain("pages/hard.md");
        expect(dump(r)).not.toContain(MARK);
      });

      it("keeps the readable row and drops the Windows-reserved one in the same response", async () => {
        const hidden = f.result("pages/CON.md", MARK);
        const readable = f.result("pages/open.md", "open text");
        const result = Object.fromEntries(
          Object.keys(hidden).map((k) => [
            k,
            k === "paths_relative_to_vault"
              ? true
              : [...(hidden[k] as unknown[]), ...(readable[k] as unknown[])],
          ]),
        );
        const v = makeM4Vault({
          files: { "pages/CON.md": MARK, "pages/open.md": "open text" },
          acl: {},
          installed: f.installed,
          routes: { [f.route]: { body: { ok: true, result } } },
        });
        cleanups.push(v.cleanup);

        const r = await call(v);
        expect(r.ok, dump(r)).toBe(true);
        expect(dump(r)).not.toContain("CON.md");
        expect(dump(r)).not.toContain(MARK);
        expect(dump(r)).toContain("pages/open.md");
      });

      it.each([".obsidian", ".git", ".trash"])(
        "drops an alias into the hard-denied %s folder",
        async (dir) => {
          const v = makeM4Vault({
            files: {
              [`${dir}/plugins/foo/data.md`]: MARK,
              "templates/ok.md": "open text",
            },
            acl: {},
            installed: f.installed,
            routes: {
              [f.route]: {
                body: {
                  ok: true,
                  result: f.result("alias/plugins/foo/data.md", MARK),
                },
              },
            },
          });
          cleanups.push(v.cleanup);
          symlinkSync(join(v.root, dir), join(v.root, "alias"));
          expect(readRefused(v, "alias/plugins/foo/data.md")).toBe(true);

          const r = await call(v);
          expect(r.ok, dump(r)).toBe(true);
          expect(dump(r)).not.toContain("alias/");
          expect(dump(r)).not.toContain(MARK);
        },
      );

      it("makes a hard-denied alias indistinguishable from an aliased nonexistent path", async () => {
        const aliasPath = "alias/bridge-acl-nonexistent-74291.md";
        const hidden = makeM4Vault({
          files: { ".obsidian/bridge-acl-nonexistent-74291.md": MARK },
          acl: {},
          installed: f.installed,
          routes: {
            [f.route]: {
              body: { ok: true, result: f.result(aliasPath, MARK) },
            },
          },
        });
        const missing = makeM4Vault({
          acl: {},
          installed: f.installed,
          routes: {
            [f.route]: {
              body: { ok: true, result: f.result(aliasPath, MARK) },
            },
          },
        });
        cleanups.push(hidden.cleanup, missing.cleanup);
        symlinkSync(join(hidden.root, ".obsidian"), join(hidden.root, "alias"));
        symlinkSync("/etc", join(missing.root, "alias"));

        const hiddenResult = await call(hidden);
        const missingResult = await call(missing);
        expect(hiddenResult.ok, dump(hiddenResult)).toBe(true);
        expect(missingResult.ok, dump(missingResult)).toBe(true);
        expect(dump(hiddenResult)).toBe(dump(missingResult));
        expect(dump(hiddenResult)).not.toContain("alias/");
        expect(dump(hiddenResult)).not.toContain(MARK);
      });

      it("returns an ordinary row", async () => {
        const result = f.result("templates/ok.md", "open text");
        const v = makeM4Vault({
          files: { "templates/ok.md": "open text" },
          acl: {},
          installed: f.installed,
          routes: { [f.route]: { body: { ok: true, result } } },
        });
        cleanups.push(v.cleanup);

        const r = await call(v);
        expect(r.ok, dump(r)).toBe(true);
        if (r.ok) {
          if (f.tool === "list_templates") {
            expect(r.data).toEqual({
              vault: "test",
              items: [{ path: "templates/ok.md", name: "template" }],
              total: 1,
            });
          } else {
            const { paths_relative_to_vault: _, ...publicResult } = result;
            expect(r.data).toEqual({ vault: "test", ...publicResult });
          }
        }
      });

      it("returns a row through an alias to a readable target", async () => {
        const v = makeM4Vault({
          files: { "shared/templates/ok.md": "open text" },
          acl: {},
          installed: f.installed,
          routes: {
            [f.route]: {
              body: { ok: true, result: f.result("alias2/templates/ok.md", "open text") },
            },
          },
        });
        cleanups.push(v.cleanup);
        symlinkSync(join(v.root, "shared"), join(v.root, "alias2"));

        const r = await call(v);
        expect(r.ok, dump(r)).toBe(true);
        expect(dump(r)).toContain("alias2/templates/ok.md");
      });

      it("still refuses a read-whitelisted caller before touching the bridge", async () => {
        const v = makeM4Vault({
          files: { "templates/ok.md": "open text" },
          acl: { readPaths: ["templates/**"] },
          installed: f.installed,
          routes: {
            [f.route]: {
              body: { ok: true, result: f.result("templates/ok.md", "open text") },
            },
          },
        });
        cleanups.push(v.cleanup);

        const r = await call(v);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("acl_denied");
        expect(v.bridgeRequests).toHaveLength(0);
      });
    });

    it("git_status rejects rows whose bridge does not certify a vault-relative path basis", async () => {
      const result = { changed: [{ working_dir: "M", index: "" }], staged: [], conflicted: [] };
      const v = makeM4Vault({
        acl: {},
        installed: ["git"],
        routes: {
          "POST /obsidian-tc/v1/git/status": { body: { ok: true, result } },
        },
      });
      cleanups.push(v.cleanup);

      const r = await v.call("git_status", { vault: "test" });
      expect(r.ok, dump(r)).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("plugin_incompatible");
        expect(r.error.message).toBe(
          "companion plugin predates vault-relative git paths; update the companion plugin inside Obsidian",
        );
      }
    });

    it("git_status judges certified mapped rows against the vault ACL", async () => {
      const result = {
        paths_relative_to_vault: true,
        changed: [
          { path: "Notes/a.md", working_dir: "M", index: "" },
          { path: ".trash/secret.md", working_dir: "M", index: "" },
        ],
        staged: [],
        conflicted: [],
      };
      const v = makeM4Vault({
        files: { "Notes/a.md": "open", ".trash/secret.md": MARK },
        acl: {},
        installed: ["git"],
        routes: {
          "POST /obsidian-tc/v1/git/status": { body: { ok: true, result } },
        },
      });
      cleanups.push(v.cleanup);

      const r = await v.call("git_status", { vault: "test" });
      expect(r.ok, dump(r)).toBe(true);
      if (r.ok) {
        expect(r.data).toEqual({
          vault: "test",
          changed: [{ path: "Notes/a.md", working_dir: "M", index: "" }],
          staged: [],
          conflicted: [],
        });
      }
    });

    describe.each(FAMILIES)("$tool", (f) => {
      it("drops a Windows-reserved path while keeping a readable row in the same response", async () => {
        const hidden = f.result("pages/CON.md", MARK);
        const readable = f.result("pages/open.md", "open text");
        const result = {
          items: [...((hidden.items as unknown[]) ?? []), ...((readable.items as unknown[]) ?? [])],
          total: 2,
        };
        const v = makeM4Vault({
          files: { "pages/CON.md": MARK, "pages/open.md": "open text" },
          acl: {},
          installed: f.installed,
          routes: { [f.route]: { body: { ok: true, result } } },
        });
        cleanups.push(v.cleanup);

        const r = await v.call(f.tool, { vault: "test", ...f.input });
        expect(r.ok, dump(r)).toBe(true);
        expect(dump(r)).not.toContain("CON.md");
        expect(dump(r)).not.toContain(MARK);
        expect(dump(r)).toContain("pages/open.md");
        if (r.ok) expect((r.data as { total: number }).total).toBe(1);
      });

      it("does not pass a path-bearing envelope without items through raw", async () => {
        const v = makeM4Vault({
          files: { "pages/open.md": "open text" },
          acl: {},
          installed: f.installed,
          routes: {
            [f.route]: {
              body: { ok: true, result: { hits: [{ path: ".trash/secret.md", excerpt: MARK }] } },
            },
          },
        });
        cleanups.push(v.cleanup);

        const r = await v.call(f.tool, { vault: "test", ...f.input });
        expect(r.ok, dump(r)).toBe(true);
        expect(dump(r)).not.toContain(MARK);
        expect(dump(r)).not.toContain(".trash");
      });

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

    it("keeps Datacore rows whose frontmatter uses path-shaped field names", async () => {
      const fields = [
        { to: "Bob" },
        { from: "2026-01-01" },
        { file: "report.pdf" },
        { to: "https://example.com/x" },
        { path: "C:\\Users\\x" },
      ];
      const items = fields.map((frontmatter) => ({ path: "pages/open.md", fields: frontmatter }));
      const v = makeM4Vault({
        files: { "pages/open.md": "open text" },
        acl: { readPaths: ["pages/**"] },
        installed: ["datacore"],
        routes: {
          "POST /obsidian-tc/v1/datacore/query": {
            body: { ok: true, result: { items, total: items.length } },
          },
        },
      });
      cleanups.push(v.cleanup);

      const r = await v.call("query_datacore", { vault: "test", query: "@page" });

      expect(r.ok, dump(r)).toBe(true);
      if (r.ok) {
        expect((r.data as { items: unknown[] }).items).toEqual(items);
        expect((r.data as { total: number }).total).toBe(5);
      }
    });

    it("judges a Dataview Link stored directly under a key named fields, not its values", () => {
      const v = vault(["tasks"], {});
      const link = (path: string) => ({ path, type: "file", embed: false });
      const kept = { path: "pages/open.md", fields: link("pages/open.md") };
      const plain = { path: "pages/open.md", fields: { path: "C:\\Users\\x", type: "contact" } };
      const rows = [
        { path: "pages/open.md", fields: link(".trash/secret.md") },
        { path: "pages/open.md", fields: [link(".trash/secret.md")] },
        { path: "pages/open.md", fields: { type: "header", path: "wiki/secret.md" } },
        kept,
        plain,
      ];

      const out = filterBridgeItemsByAcl(v.acl, v.root, ["*"], rows, { tool: "t" });

      expect(out).toEqual([kept, plain]);
    });

    it("leaves plain path-keyed maps nested deeper under fields unchecked", () => {
      const v = vault(["tasks"], {});
      const rows = [
        { path: "pages/open.md", fields: { home: { path: "C:\\Users\\x" } } },
        { path: "pages/open.md", fields: { cover: { path: "assets/img.png" } } },
        { path: "pages/open.md", fields: { list: [{ path: "C:\\Users\\x" }] } },
      ];

      const out = filterBridgeItemsByAcl(v.acl, v.root, ["*"], rows, { tool: "t" });

      expect(out).toEqual(rows);
    });

    describe.each(ITEM_LIST_FAMILIES)("$tool: links nested under fields", (f) => {
      it("drops a row whose fields contain an unreadable Link object", async () => {
        const outerPath =
          f.tool === "makemd_query" ? { note_path: "pages/open.md" } : { path: "pages/open.md" };
        const row = {
          ...outerPath,
          fields: {
            owner: "Bob",
            related: { value: { path: ".trash/secret.md", type: "file" } },
          },
        };
        const v = makeM4Vault({
          files: { "pages/open.md": "open text", ".trash/secret.md": MARK },
          acl: {},
          installed: f.installed,
          routes: {
            [f.route]: { body: { ok: true, result: { items: [row], total: 1 } } },
          },
        });
        cleanups.push(v.cleanup);

        const r = await v.call(f.tool, { vault: "test", ...f.input });

        expect(r.ok, dump(r)).toBe(true);
        if (r.ok) {
          expect((r.data as { items: unknown[] }).items).toEqual([]);
          expect((r.data as { total: number }).total).toBe(0);
        }
      });
    });

    describe.each(ITEM_LIST_FAMILIES)("$tool: listed result fields", (f) => {
      it("drops an unlisted companion field for an unrestricted caller", async () => {
        const result = {
          items: [],
          hits: [{ path: ".trash/secret.md", excerpt: "TOPSECRET" }],
        };
        const v = makeM4Vault({
          acl: {},
          installed: f.installed,
          routes: { [f.route]: { body: { ok: true, result } } },
        });
        cleanups.push(v.cleanup);

        const r = await v.call(f.tool, { vault: "test", ...f.input });
        expect(r.ok, dump(r)).toBe(true);
        if (r.ok) expect(r.data).not.toHaveProperty("hits");
        expect(dump(r)).not.toContain("TOPSECRET");
      });
    });

    it("returns the same key set whether or not an Omnisearch item is dropped", async () => {
      const search = (result: Record<string, unknown>) =>
        makeM4Vault({
          files: { "pages/open.md": "open", ".trash/secret.md": MARK },
          acl: {},
          installed: ["omnisearch"],
          routes: {
            "POST /obsidian-tc/v1/omnisearch/search": {
              body: { ok: true, result },
            },
          },
        });
      const kept = search({
        items: [{ path: "pages/open.md", excerpt: "open" }],
        total: 1,
        query: "x",
        groups: [],
      });
      const dropped = search({
        items: [{ path: ".trash/secret.md", excerpt: MARK }],
        total: 1,
        query: "x",
        groups: [],
      });
      cleanups.push(kept.cleanup, dropped.cleanup);

      const keptResult = await kept.call("search_omnisearch", { vault: "test", query: "x" });
      const droppedResult = await dropped.call("search_omnisearch", {
        vault: "test",
        query: "x",
      });
      expect(keptResult.ok, dump(keptResult)).toBe(true);
      expect(droppedResult.ok, dump(droppedResult)).toBe(true);
      if (keptResult.ok && droppedResult.ok) {
        expect(Object.keys(keptResult.data as Record<string, unknown>).sort()).toEqual(
          Object.keys(droppedResult.data as Record<string, unknown>).sort(),
        );
      }
    });

    describe.each(UNRESTRICTED_PATH_FAMILIES)("$tool: invalid bridge paths", (f) => {
      it("drops a Windows-reserved path", async () => {
        const v = makeM4Vault({
          files: { "pages/CON.md": MARK },
          acl: {},
          installed: f.installed,
          routes: { [f.route]: { body: { ok: true, result: f.result("pages/CON.md", MARK) } } },
        });
        cleanups.push(v.cleanup);

        const r = await v.call(f.tool, { vault: "test", ...f.input });
        expect(r.ok, dump(r)).toBe(true);
        expect(dump(r)).not.toContain("CON.md");
        expect(dump(r)).not.toContain(MARK);
      });
    });

    it("git_status drops a rename when its from path is unreadable", async () => {
      const v = makeM4Vault({
        files: { "pages/new.md": "open", ".trash/old-secret.md": MARK },
        acl: {},
        installed: ["git"],
        routes: {
          "POST /obsidian-tc/v1/git/status": {
            body: {
              ok: true,
              result: {
                paths_relative_to_vault: true,
                changed: [{ path: "pages/new.md", from: ".trash/old-secret.md", working_dir: "R" }],
                staged: [],
                conflicted: [],
              },
            },
          },
        },
      });
      cleanups.push(v.cleanup);

      const r = await v.call("git_status", { vault: "test" });
      expect(r.ok, dump(r)).toBe(true);
      expect(dump(r)).not.toContain("old-secret.md");
      expect(dump(r)).not.toContain("pages/new.md");
    });

    it("git_status drops an unlisted renamed field without losing an allowed status entry", async () => {
      const v = makeM4Vault({
        files: { "pages/open.md": "open", ".trash/secret.md": MARK },
        acl: {},
        installed: ["git"],
        routes: {
          "POST /obsidian-tc/v1/git/status": {
            body: {
              ok: true,
              result: {
                paths_relative_to_vault: true,
                changed: [{ path: "pages/open.md", working_dir: "M", index: "" }],
                staged: [],
                conflicted: [],
                renamed: [{ from: ".trash/secret.md" }],
              },
            },
          },
        },
      });
      cleanups.push(v.cleanup);

      const r = await v.call("git_status", { vault: "test" });
      expect(r.ok, dump(r)).toBe(true);
      expect(dump(r)).toContain("pages/open.md");
      expect(dump(r)).not.toContain(".trash/secret.md");
      if (r.ok) expect(r.data).not.toHaveProperty("renamed");
    });

    describe.each(GIT_PROJECTION_CASES)("$tool: listed result fields", (f) => {
      it("drops unlisted companion fields", async () => {
        const v = makeM4Vault({
          files: { "pages/open.md": "open", ".trash/secret.md": MARK },
          installed: ["git"],
          routes: { [f.route]: { body: { ok: true, result: f.result } } },
        });
        cleanups.push(v.cleanup);

        const input = { vault: "test", ...f.input };
        const r = f.confirmed ? await v.callConfirmed(f.tool, input) : await v.call(f.tool, input);
        expect(r.ok, dump(r)).toBe(true);
        expect(dump(r)).not.toContain("TOPSECRET");
        if (r.ok)
          expect(Object.keys(r.data as Record<string, unknown>).sort()).toEqual(
            [...f.expectedKeys].sort(),
          );
      });
    });

    it.each([
      { acl: { readPaths: ["Daily/**"] }, label: "restricted" },
      { acl: {}, label: "unrestricted" },
    ])("resolve_daily_note drops undeclared fields for a $label caller", async ({ acl }) => {
      const result = {
        path: "Daily/2026-10-15.md",
        exists: true,
        hits: [{ path: ".trash/secret.md", excerpt: "TOPSECRET" }],
      };
      const v = makeM4Vault({
        files: { "Daily/2026-10-15.md": "open" },
        acl,
        routes: {
          "POST /obsidian-tc/v1/daily-notes/resolve": { body: { ok: true, result } },
        },
      });
      cleanups.push(v.cleanup);

      const r = await v.call("resolve_daily_note", { vault: "test" });
      expect(r.ok, dump(r)).toBe(true);
      expect(dump(r)).not.toContain("TOPSECRET");
      expect(dump(r)).not.toContain(".trash/");
    });

    it("search_omnisearch drops a row with the incident nested inside it", async () => {
      const result = {
        items: [
          {
            path: "pages/open.md",
            excerpt: "open",
            hits: [{ path: ".trash/secret.md", excerpt: "TOPSECRET" }],
            to: ".trash/secret.md",
          },
        ],
        total: 1,
      };
      const v = makeM4Vault({
        files: { "pages/open.md": "open" },
        acl: { readPaths: ["pages/**"] },
        installed: ["omnisearch"],
        routes: {
          "POST /obsidian-tc/v1/omnisearch/search": { body: { ok: true, result } },
        },
      });
      cleanups.push(v.cleanup);

      const r = await v.call("search_omnisearch", { vault: "test", query: "x" });
      expect(r.ok, dump(r)).toBe(true);
      expect(dump(r)).not.toContain("TOPSECRET");
      expect(dump(r)).not.toContain(".trash/");
    });

    it("git_status projects row fields before returning them", async () => {
      const result = {
        paths_relative_to_vault: true,
        changed: [
          {
            path: "pages/open.md",
            working_dir: "R",
            index: "R",
            to: ".trash/secret.md",
            hits: [{ path: ".trash/secret.md", excerpt: "TOPSECRET" }],
          },
        ],
        staged: [],
        conflicted: [],
      };
      const v = makeM4Vault({
        files: { "pages/open.md": "open" },
        acl: {},
        installed: ["git"],
        routes: { "POST /obsidian-tc/v1/git/status": { body: { ok: true, result } } },
      });
      cleanups.push(v.cleanup);

      const r = await v.call("git_status", { vault: "test" });
      expect(r.ok, dump(r)).toBe(true);
      expect(dump(r)).not.toContain("TOPSECRET");
      expect(dump(r)).not.toContain(".trash/");
    });

    it("git_log projects entry fields before returning them", async () => {
      const result = {
        entries: [
          {
            hash: "abc",
            message: "open",
            date: "2026-10-15",
            author: "A",
            hits: [{ path: ".trash/secret.md", excerpt: "TOPSECRET" }],
          },
        ],
      };
      const v = makeM4Vault({
        acl: {},
        installed: ["git"],
        routes: { "POST /obsidian-tc/v1/git/log": { body: { ok: true, result } } },
      });
      cleanups.push(v.cleanup);

      const r = await v.call("git_log", { vault: "test" });
      expect(r.ok, dump(r)).toBe(true);
      expect(dump(r)).not.toContain("TOPSECRET");
      expect(dump(r)).not.toContain(".trash/");
    });

    describe.each(COMPANION_PROJECTION_CASES)("$tool: companion projection", (f) => {
      it("does not expose undeclared incident fields", async () => {
        const v = makeM4Vault({
          acl: {},
          installed: f.installed,
          files: f.files,
          commandPolicy: f.commandPolicy,
          routes: { [f.route]: { body: { ok: true, result: f.result } } },
        });
        cleanups.push(v.cleanup);

        const input = { vault: "test", ...f.input };
        const r = f.confirmed ? await v.callConfirmed(f.tool, input) : await v.call(f.tool, input);
        expect(r.ok, dump(r)).toBe(true);
        expect(dump(r)).not.toContain("TOPSECRET");
        expect(dump(r)).not.toContain(".trash/");
      });
    });

    describe.each([
      {
        tool: "git_diff",
        route: "POST /obsidian-tc/v1/git/diff",
        input: { path: "pages/open.md" },
        result: {},
      },
      {
        tool: "git_stage",
        route: "POST /obsidian-tc/v1/git/stage",
        input: { paths: ["pages/open.md"] },
        result: { staged: 1.5 },
      },
      {
        tool: "git_commit",
        route: "POST /obsidian-tc/v1/git/commit",
        input: { message: "snapshot" },
        result: { committed: 1 },
        confirmed: true,
      },
    ])("$tool: malformed companion response", (f) => {
      it("raises the bridge-shape error instead of manufacturing a valid value", async () => {
        const v = makeM4Vault({
          files: { "pages/open.md": "open" },
          installed: ["git"],
          routes: { [f.route]: { body: { ok: true, result: f.result } } },
        });
        cleanups.push(v.cleanup);

        const input = { vault: "test", ...f.input };
        const r = f.confirmed ? await v.callConfirmed(f.tool, input) : await v.call(f.tool, input);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe("plugin_incompatible");
          expect(r.error.retryable).toBe(false);
        }
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

      it("derives the returned folder from the checked path", async () => {
        const v = makeM4Vault({
          files: { "pages/open.md": "open" },
          acl: { readPaths: ["pages/**"] },
          routes: {
            "POST /obsidian-tc/v1/daily-notes/resolve": {
              body: {
                ok: true,
                result: {
                  path: "pages/open.md",
                  exists: true,
                  folder: ".trash/secret.md",
                  format: "TOPSECRET",
                },
              },
            },
          },
        });
        cleanups.push(v.cleanup);

        const r = await v.call("resolve_daily_note", { vault: "test" });

        expect(r.ok, dump(r)).toBe(true);
        if (r.ok) expect((r.data as { folder?: string }).folder).toBe("pages");
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
