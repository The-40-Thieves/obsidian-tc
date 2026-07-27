// THE-602: closes uncovered branches in src/tools/m3/periodic-tools.ts left by the vitest-4
// AST-aware branch remapping. Every test here asserts real caller-visible behavior (a returned
// value, a file's actual content, or a thrown error's code) — never just "the branch executed".
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import type { BridgeClient } from "../src/bridge";
import { provisionCacheDb } from "../src/db/provision";
import type { CallerContext } from "../src/mcp/registry";
import { ToolRegistry } from "../src/mcp/registry";
import { registerM3Tools } from "../src/tools/m3";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeM3Vault } from "./m3-helpers";

describe("periodic-tools branch coverage: stepDate across every period", () => {
  // stepDate's if/else-if/else chain (daily/weekly/monthly/quarterly/yearly) backs both the
  // default `from` computation and the per-iteration loop step in list_periodic_notes. Existing
  // suites only ever exercise "daily"; drive the other four periods explicitly here.
  it("steps a weekly range and lands on the ISO week file names", async () => {
    const v = makeM3Vault({
      files: { "2026-W25.md": "a", "2026-W26.md": "b" },
    });
    try {
      const r = await v.call("list_periodic_notes", {
        vault: "test",
        period: "weekly",
        from: "2026-06-15",
        to: "2026-06-29",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { total: number; items: Array<{ path: string }> };
        expect(d.items.map((i) => i.path).sort()).toEqual(["2026-W25.md", "2026-W26.md"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("steps a monthly range and lands on YYYY-MM file names", async () => {
    const v = makeM3Vault({ files: { "2026-05.md": "a", "2026-06.md": "b" } });
    try {
      const r = await v.call("list_periodic_notes", {
        vault: "test",
        period: "monthly",
        from: "2026-05-01",
        to: "2026-06-30",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ path: string }> };
        expect(d.items.map((i) => i.path).sort()).toEqual(["2026-05.md", "2026-06.md"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("steps a quarterly range and lands on YYYY-QN file names", async () => {
    const v = makeM3Vault({ files: { "2026-Q1.md": "a", "2026-Q2.md": "b" } });
    try {
      const r = await v.call("list_periodic_notes", {
        vault: "test",
        period: "quarterly",
        from: "2026-01-01",
        to: "2026-06-30",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ path: string }> };
        expect(d.items.map((i) => i.path).sort()).toEqual(["2026-Q1.md", "2026-Q2.md"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("steps a yearly range and lands on YYYY file names", async () => {
    const v = makeM3Vault({ files: { "2025.md": "a", "2026.md": "b" } });
    try {
      const r = await v.call("list_periodic_notes", {
        vault: "test",
        period: "yearly",
        from: "2025-01-01",
        to: "2026-12-31",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ path: string }> };
        expect(d.items.map((i) => i.path).sort()).toEqual(["2025.md", "2026.md"]);
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("periodic-tools branch coverage: appendContent separators and heading edge cases", () => {
  it("preserves CRLF line endings when inserting under a heading", async () => {
    const v = makeM3Vault({
      files: { "2026-06-18.md": "# Day\r\n\r\n## Log\r\nexisting\r\n\r\n## Notes\r\nn\r\n" },
    });
    try {
      const r = await v.call("append_to_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
        content: "new line",
        heading: "Log",
      });
      expect(r.ok).toBe(true);
      const body = v.read("2026-06-18.md");
      // The inserted line and the joined document must use \r\n throughout, not \n.
      expect(body).toContain("existing\r\n\r\nnew line\r\n## Notes");
      expect(body).not.toMatch(/[^\r]\n/);
    } finally {
      v.cleanup();
    }
  });

  it("stops the closing-heading scan at a same-or-higher-level heading, skipping deeper subheadings", async () => {
    const v = makeM3Vault({
      files: {
        "2026-06-18.md": "## Log\nexisting\n### Sub\nsub content\n## Notes\nn\n",
      },
    });
    try {
      const r = await v.call("append_to_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
        content: "new line",
        heading: "Log",
      });
      expect(r.ok).toBe(true);
      const body = v.read("2026-06-18.md");
      // Insertion point is right before "## Notes" (same level 2), NOT before "### Sub" (level 3,
      // deeper — must be skipped).
      expect(body).toBe("## Log\nexisting\n### Sub\nsub content\nnew line\n## Notes\nn\n");
    } finally {
      v.cleanup();
    }
  });

  it("creates a new heading section (with a leading separator) when the heading is absent from non-empty content", async () => {
    const v = makeM3Vault({ files: { "2026-06-18.md": "existing body no trailing newline" } });
    try {
      const r = await v.call("append_to_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
        content: "new task",
        heading: "Log",
      });
      expect(r.ok).toBe(true);
      expect(v.read("2026-06-18.md")).toBe("existing body no trailing newline\n## Log\nnew task");
    } finally {
      v.cleanup();
    }
  });

  it("creates a new heading section with no leading separator when the note is newly created (empty)", async () => {
    const v = makeM3Vault();
    try {
      const r = await v.call("append_to_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
        content: "new task",
        heading: "Log",
      });
      expect(r.ok).toBe(true);
      // existing === "" so the `existing.length > 0` guard is false: no leading separator.
      expect(v.read("2026-06-18.md")).toBe("## Log\nnew task");
    } finally {
      v.cleanup();
    }
  });

  it("no-heading append: inserts a separator when the prior content doesn't end with a newline", async () => {
    const v = makeM3Vault();
    try {
      const first = await v.call("append_to_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
        content: "hello",
      });
      expect(first.ok).toBe(true);
      expect(v.read("2026-06-18.md")).toBe("hello");

      const second = await v.call("append_to_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
        content: "world",
      });
      expect(second.ok).toBe(true);
      // "hello" has no trailing newline and ensure_newline defaults true: a \n is inserted.
      expect(v.read("2026-06-18.md")).toBe("hello\nworld");
    } finally {
      v.cleanup();
    }
  });

  it("no-heading append: ensure_newline=false skips the separator even without a trailing newline", async () => {
    const v = makeM3Vault({ files: { "2026-06-18.md": "hello" } });
    try {
      const r = await v.call("append_to_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
        content: "world",
        ensure_newline: false,
      });
      expect(r.ok).toBe(true);
      expect(v.read("2026-06-18.md")).toBe("helloworld");
    } finally {
      v.cleanup();
    }
  });
});

describe("periodic-tools branch coverage: loadTemplate null-return legs", () => {
  it("create_periodic_note rejects a template_override that does not exist", async () => {
    const v = makeM3Vault();
    try {
      const r = await v.call("create_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
        template_override: "templates/missing.md",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
      expect(v.exists("2026-06-18.md")).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("create_periodic_note rejects a template_override that resolves to a folder", async () => {
    const v = makeM3Vault({ files: { "templates/daily.md": "x" } });
    try {
      const r = await v.call("create_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
        template_override: "templates",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });
});

describe("periodic-tools branch coverage: config-resolved template (no template_override)", () => {
  it("create_periodic_note uses the periodic-notes plugin's configured template when no override is given", async () => {
    const v = makeM3Vault({
      files: {
        ".obsidian/plugins/periodic-notes/data.json": JSON.stringify({
          daily: { template: "templates/day.md" },
        }),
        "templates/day.md": "# Configured template\n",
      },
    });
    try {
      const r = await v.call("create_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
      });
      expect(r.ok).toBe(true);
      if (r.ok)
        expect((r.data as { template_used: string | null }).template_used).toBe("templates/day.md");
      expect(v.read("2026-06-18.md")).toBe("# Configured template\n");
    } finally {
      v.cleanup();
    }
  });

  it("create_periodic_note falls back to empty content when the configured template file is missing", async () => {
    const v = makeM3Vault({
      files: {
        ".obsidian/plugins/periodic-notes/data.json": JSON.stringify({
          daily: { template: "templates/gone.md" },
        }),
      },
    });
    try {
      const r = await v.call("create_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { template_used: string | null }).template_used).toBeNull();
      expect(v.read("2026-06-18.md")).toBe("");
    } finally {
      v.cleanup();
    }
  });

  it("find_or_create_periodic_note uses the configured template on first creation", async () => {
    const v = makeM3Vault({
      files: {
        ".obsidian/daily-notes.json": JSON.stringify({ template: "templates/day.md" }),
        "templates/day.md": "# Day template\n",
      },
    });
    try {
      const r = await v.call("find_or_create_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { created: boolean }).created).toBe(true);
      expect(v.read("2026-06-18.md")).toBe("# Day template\n");
    } finally {
      v.cleanup();
    }
  });
});

describe("periodic-tools branch coverage: find_or_create_periodic_note expand_template", () => {
  const daily = { vault: "test", period: "daily", date: "2026-06-18" } as const;

  // Unlike create_periodic_note (which never reads the note back), find_or_create_periodic_note
  // always reads the file after creation to populate `content`/`frontmatter` — so, matching the
  // real Templater bridge contract ("returns true when the bridge wrote it", periodic-tools.ts
  // expandViaTemplater docstring), this stub actually writes `target` under the vault root rather
  // than merely recording the call. A stub that claimed success without writing produced a bare
  // ENOENT (surfaced as an opaque `internal` error) purely because the stub was unrealistic, not
  // because of a bug in the handler.
  function stubBridge(getRoot: () => string, opts: { throwCode?: string } = {}) {
    const calls: Array<Record<string, unknown>> = [];
    const templaterBridge = () => ({
      client: {
        request: async (req: { body?: Record<string, unknown> }) => {
          calls.push(req.body ?? {});
          if (opts.throwCode)
            throw new ObsidianTcError(
              opts.throwCode as ConstructorParameters<typeof ObsidianTcError>[0],
              "degraded",
            );
          const target = req.body?.target;
          if (typeof target === "string") {
            const abs = join(getRoot(), target);
            mkdirSync(join(abs, ".."), { recursive: true });
            writeFileSync(abs, "EXPANDED");
          }
          return {};
        },
      } as unknown as BridgeClient,
      timeoutMs: 1000,
    });
    return { templaterBridge, calls };
  }

  it("expand_template without write:templater is forbidden and leaves the note uncreated", async () => {
    let root = "";
    const { templaterBridge } = stubBridge(() => root);
    const v = makeM3Vault({
      files: {
        ".obsidian/daily-notes.json": JSON.stringify({ template: "templates/day.md" }),
        "templates/day.md": "BODY",
      },
      templaterBridge,
    });
    root = v.root;
    try {
      const r = await v.call(
        "find_or_create_periodic_note",
        { ...daily, expand_template: true },
        { grantedScopes: new Set(["read:periodic", "write:periodic"]) },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("forbidden");
      expect(v.exists("2026-06-18.md")).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("expand_template delegates the write to Templater when a configured template + scope are present", async () => {
    let root = "";
    const { templaterBridge, calls } = stubBridge(() => root);
    const v = makeM3Vault({
      files: {
        ".obsidian/daily-notes.json": JSON.stringify({ template: "templates/day.md" }),
        "templates/day.md": "# <% tp.date.now() %>",
      },
      templaterBridge,
    });
    root = v.root;
    try {
      const r = await v.call("find_or_create_periodic_note", { ...daily, expand_template: true });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect((r.data as { created: boolean }).created).toBe(true);
        // The bridge wrote the note (real-world Templater behavior); the handler must read that
        // content back rather than the tool's own (skipped) verbatim copy.
        expect((r.data as { content?: string }).content).toBe("EXPANDED");
      }
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ template: "templates/day.md", target: "2026-06-18.md" });
      expect(v.read("2026-06-18.md")).toBe("EXPANDED");
    } finally {
      v.cleanup();
    }
  });

  it("expand_template=true with no configured template is a no-op verbatim create (templateUsed stays null)", async () => {
    const v = makeM3Vault();
    try {
      const r = await v.call("find_or_create_periodic_note", { ...daily, expand_template: true });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { created: boolean }).created).toBe(true);
      expect(v.read("2026-06-18.md")).toBe("");
    } finally {
      v.cleanup();
    }
  });
});

describe("periodic-tools branch coverage: include_content=false", () => {
  it("get_periodic_note omits content/frontmatter when include_content=false", async () => {
    const v = makeM3Vault({ files: { "2026-06-18.md": "# hi\nbody" } });
    try {
      const r = await v.call("get_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
        include_content: false,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as Record<string, unknown>;
        expect(d.exists).toBe(true);
        expect("content" in d).toBe(false);
        expect("frontmatter" in d).toBe(false);
      }
    } finally {
      v.cleanup();
    }
  });

  it("find_or_create_periodic_note omits content/frontmatter when include_content=false", async () => {
    const v = makeM3Vault();
    try {
      const r = await v.call("find_or_create_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
        include_content: false,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as Record<string, unknown>;
        expect(d.created).toBe(true);
        expect("content" in d).toBe(false);
        expect("frontmatter" in d).toBe(false);
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("periodic-tools branch coverage: append_to_periodic_note folder conflict", () => {
  it("rejects with invalid_input when the resolved target path is an existing folder", async () => {
    const v = makeM3Vault();
    mkdirSync(join(v.root, "2026-06-18.md"), { recursive: true });
    try {
      const r = await v.call("append_to_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
        content: "hello",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });
});

describe("periodic-tools branch coverage: list_periodic_notes", () => {
  it("rejects a from date that is after the to date", async () => {
    const v = makeM3Vault();
    try {
      const r = await v.call("list_periodic_notes", {
        vault: "test",
        period: "daily",
        from: "2026-06-20",
        to: "2026-06-18",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("honors a configured folder when probing candidate paths", async () => {
    const v = makeM3Vault({
      files: {
        ".obsidian/daily-notes.json": JSON.stringify({ folder: "Journal" }),
        "Journal/2026-06-17.md": "a",
        "Journal/2026-06-18.md": "b",
      },
    });
    try {
      const r = await v.call("list_periodic_notes", {
        vault: "test",
        period: "daily",
        from: "2026-06-16",
        to: "2026-06-18",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { total: number; items: Array<{ path: string }> };
        expect(d.total).toBe(2);
        expect(d.items.map((i) => i.path).sort()).toEqual([
          "Journal/2026-06-17.md",
          "Journal/2026-06-18.md",
        ]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("sets overflow=true when the scan exceeds LIST_MAX_STEPS before reaching `to`", async () => {
    const v = makeM3Vault();
    try {
      // Daily period steps by 1 day; a multi-decade range walks well past the 5000-step cap.
      const r = await v.call("list_periodic_notes", {
        vault: "test",
        period: "daily",
        from: "1990-01-01",
        to: "2030-01-01",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { overflow?: boolean };
        expect(d.overflow).toBe(true);
      }
    } finally {
      v.cleanup();
    }
  }, 20000);

  it("paginates with next_cursor, and a non-numeric cursor falls back to offset 0", async () => {
    const v = makeM3Vault({
      files: {
        "2026-06-15.md": "a",
        "2026-06-16.md": "b",
        "2026-06-17.md": "c",
        "2026-06-18.md": "d",
      },
    });
    try {
      const page1 = await v.call("list_periodic_notes", {
        vault: "test",
        period: "daily",
        from: "2026-06-15",
        to: "2026-06-18",
        limit: 2,
      });
      expect(page1.ok).toBe(true);
      if (page1.ok) {
        const d = page1.data as {
          total: number;
          items: Array<{ path: string }>;
          next_cursor?: string;
        };
        expect(d.total).toBe(4);
        expect(d.items).toHaveLength(2);
        expect(d.next_cursor).toBe("2");

        const page2 = await v.call("list_periodic_notes", {
          vault: "test",
          period: "daily",
          from: "2026-06-15",
          to: "2026-06-18",
          limit: 2,
          cursor: d.next_cursor,
        });
        expect(page2.ok).toBe(true);
        if (page2.ok) {
          const d2 = page2.data as { items: Array<{ path: string }>; next_cursor?: string };
          expect(d2.items).toHaveLength(2);
          expect(d2.next_cursor).toBeUndefined();
        }
      }

      // A non-numeric cursor makes Number.parseInt return NaN; the `|| 0` fallback resets to the
      // first page rather than throwing or reading out of bounds.
      const garbled = await v.call("list_periodic_notes", {
        vault: "test",
        period: "daily",
        from: "2026-06-15",
        to: "2026-06-18",
        limit: 2,
        cursor: "not-a-number",
      });
      expect(garbled.ok).toBe(true);
      if (garbled.ok) {
        const d = garbled.data as { items: Array<{ path: string }> };
        expect(d.items.map((i) => i.path)).toEqual(["2026-06-15.md", "2026-06-16.md"]);
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("periodic-tools branch coverage: create_periodic_note's pathAcl extractor (both legs)", () => {
  // def.pathAcl is only invoked by runDispatch's central folder-ACL stage when a rootResolver is
  // wired (registry.ts: `const root = this.rootResolver?.(effVault); if (root) { ... def.pathAcl(...) }`).
  // makeM3Vault's harness never wires one (mirroring most tools, which rely on handler-side
  // enforcePathAcl instead), so both legs of `input.template_override ? [...] : []` on
  // periodic-tools.ts:285 need a registry built with rootResolver, same as the THE-567 suite's own
  // local setup.
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "obtc-602-pathacl-"));
    const db = openMemoryDb();
    provisionCacheDb(db);
    const acl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
    const vaultRegistry = new VaultRegistry([{ id: "test", path: root }]);
    const registry = new ToolRegistry({ rootResolver: () => root });
    registerM3Tools(registry, { vaultRegistry });
    const ctx: CallerContext = {
      caller: "t",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "test",
      db,
      acl,
    };
    return { root, registry, ctx };
  }

  it("declares a read op on template_override when present", async () => {
    const { root, registry, ctx } = setup();
    try {
      mkdirSync(join(root, "templates"), { recursive: true });
      writeFileSync(join(root, "templates", "daily.md"), "# T\n");
      const r = await registry.dispatch(
        "create_periodic_note",
        {
          vault: "test",
          period: "daily",
          date: "2026-06-18",
          template_override: "templates/daily.md",
        },
        ctx,
      );
      expect(r.ok).toBe(true);
      if (r.ok)
        expect((r.data as { template_used: string }).template_used).toBe("templates/daily.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("declares no path ops when template_override is absent", async () => {
    const { root, registry, ctx } = setup();
    try {
      const r = await registry.dispatch(
        "create_periodic_note",
        { vault: "test", period: "daily", date: "2026-06-18" },
        ctx,
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { template_used: string | null }).template_used).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("periodic-tools branch coverage: find_or_create_periodic_note with a dangling configured template", () => {
  it("falls back to an empty note when the configured template file does not exist", async () => {
    const v = makeM3Vault({
      files: {
        ".obsidian/daily-notes.json": JSON.stringify({ template: "templates/gone.md" }),
      },
    });
    try {
      const r = await v.call("find_or_create_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { created: boolean }).created).toBe(true);
      expect(v.read("2026-06-18.md")).toBe("");
    } finally {
      v.cleanup();
    }
  });
});

describe("periodic-tools branch coverage: expandViaTemplater propagates a genuine (non-degrade) failure", () => {
  // TEMPLATER_DEGRADE only covers "expansion unavailable" codes; anything else (or a raw,
  // non-ObsidianTcError throw) is a real execution failure and must propagate to the caller
  // rather than silently falling back to a verbatim copy.
  it("rethrows an ObsidianTcError whose code is not in the degrade set", async () => {
    const templaterBridge = () => ({
      client: {
        request: async () => {
          throw new ObsidianTcError("internal", "template execution blew up");
        },
      } as unknown as BridgeClient,
      timeoutMs: 1000,
    });
    const v = makeM3Vault({ files: { "templates/daily.md": "BODY" }, templaterBridge });
    try {
      const r = await v.call("create_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
        template_override: "templates/daily.md",
        expand_template: true,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("internal");
      // Must not have silently fallen back to a verbatim copy.
      expect(v.exists("2026-06-18.md")).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("propagates a plain (non-ObsidianTcError) throw from the bridge as an internal error", async () => {
    const templaterBridge = () => ({
      client: {
        request: async () => {
          throw new Error("network blew up");
        },
      } as unknown as BridgeClient,
      timeoutMs: 1000,
    });
    const v = makeM3Vault({ files: { "templates/daily.md": "BODY" }, templaterBridge });
    try {
      const r = await v.call("create_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
        template_override: "templates/daily.md",
        expand_template: true,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("internal");
      expect(v.exists("2026-06-18.md")).toBe(false);
    } finally {
      v.cleanup();
    }
  });
});
