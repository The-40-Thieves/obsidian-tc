// Every registered mutating tool that can write a note either advertises `conventions` in its output
// schema (the write runs the folder conventions check), or is listed here: CONVENTIONS_PENDING for a
// write tool not yet wired (the next slice empties it), or CONVENTIONS_EXEMPT with a reason it never
// writes a Markdown note the check could judge. A new write tool in neither list fails this test.
import { afterAll, describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { isMutatingCall } from "../src/mcp/registry/policy-gates";
import { JobQueue } from "../src/scheduler/job-queue";
import { buildRepresentationManifest } from "../src/search/representation";
import { RateLimiter } from "../src/throttle";
import { createHealthTool, createIndexStatusTool } from "../src/tools/admin/health";
import { createTaskCancelTool } from "../src/tools/admin/task-cancel";
import { createTaskStatusTool } from "../src/tools/admin/task-status";
import { registerM1Tools } from "../src/tools/m1";
import { registerM2Tools } from "../src/tools/m2";
import { registerM3Tools } from "../src/tools/m3";
import { registerM4Tools } from "../src/tools/m4";
import { registerM5Tools } from "../src/tools/m5";
import { registerM6Tools } from "../src/tools/m6";
import { registerM7Tools } from "../src/tools/m7";
import { registerM8Tools } from "../src/tools/m8";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

// A write tool that is not wired yet. PR 4 of the conventions slice empties this set.
const CONVENTIONS_PENDING = new Set<string>([
  "add_tag",
  "remove_tag",
  "update_frontmatter",
  "restore_note",
  "format_table",
  "insert_table_row",
  "insert_table_column",
  "sort_table_by_column",
  "create_periodic_note",
  "update_task",
  "execute_template",
  "commit_capture",
  "bulk_create_notes",
  "bulk_set_property",
  "bulk_move_notes",
  "commit_wiki_page",
  "append_to_periodic_note",
  "find_or_create_periodic_note",
  "rewrite_link",
]);

// Mutating tools with no pathAcl that still write Markdown notes: found by reading each mutating tool that
// names no path. They are writers, so the pending check below sees them; none declares conventions yet.
const NOTE_WRITERS_WITHOUT_PATH_ACL = new Set<string>([
  "append_to_periodic_note",
  "find_or_create_periodic_note",
  "rewrite_link",
]);

// Mutating tools that write no Markdown note the conventions check can judge.
const CONVENTIONS_EXEMPT = new Map<string, string>([
  ["create_canvas", "canvas JSON, not a Markdown note"],
  ["update_canvas", "canvas JSON, not a Markdown note"],
  ["create_base", "base JSON, not a Markdown note"],
  ["update_base", "base JSON, not a Markdown note"],
  ["add_bookmark", "bookmark JSON, not a Markdown note"],
  ["remove_bookmark", "bookmark JSON, not a Markdown note"],
  ["open_workspace", "workspace JSON, not a Markdown note"],
  ["save_workspace", "workspace JSON, not a Markdown note"],
  ["create_excalidraw", "Excalidraw drawing, not a Markdown note"],
  ["update_excalidraw", "Excalidraw drawing, not a Markdown note"],
  ["add_kanban_card", "Kanban board, not a Markdown note"],
  ["move_kanban_card", "Kanban board, not a Markdown note"],
  ["prune_hub_links", "rewrites links in place, no note-level conventions judgment"],
  ["delete_note", "a delete writes no note"],
  ["delete_attachment", "a delete writes no note"],
  ["delete_active_file", "a delete writes no note"],
  ["move_attachment", "attachment file, not a Markdown note"],
  ["write_attachment", "attachment bytes, not a Markdown note"],
  ["git_stage", "Git companion bridge, writes no note"],
  ["show_file_in_obsidian", "Obsidian UI bridge, writes no note"],
]);

const NO_THROTTLE = {
  read: { perMinute: 1e6, burst: 1e6 },
  write: { perMinute: 1e6, burst: 1e6 },
  bulk: { perMinute: 1e6, burst: 1e6 },
  execute: { perMinute: 1e6, burst: 1e6 },
  admin: { perMinute: 1e6, burst: 1e6 },
};

describe("conventions tool coverage", () => {
  const root = makeTempDir("obtc-conv-cov-");
  afterAll(() => rmTemp(root));

  it("every mutating note writer declares conventions, or is pending or exempt", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const vaultRegistry = new VaultRegistry([{ id: "t", name: "t", path: root }]);
    const rateLimiter = new RateLimiter(NO_THROTTLE as never);
    const registry = new ToolRegistry({ rateLimiter });
    const noop = () => {};
    // Registration only builds tool definitions; these stubs are never dereferenced.
    const embeddingProvider: any = {
      provider: "ollama",
      model: "nomic-embed-text",
      embed: async () => [],
    };
    const metadataIndex = { hasFts: false, ready: () => true };
    const bridge: any = () => ({ client: undefined, timeoutMs: 1000 });
    registry.register(
      createHealthTool({
        version: "test",
        vaults: ["t"],
        startedAt: 0,
        nativeLoaded: false,
        vecEnabled: false,
        ftsEnabled: false,
      }),
    );
    registry.register(
      createIndexStatusTool({
        vecEnabled: false,
        ftsEnabled: false,
        getIndexHealth: () => ({ reconcile: "ok", reconcile_at: null, write_failures: 0 }),
        getLastChunksUpserted: () => null,
      }),
    );
    registry.register(createTaskStatusTool({ queue: new JobQueue(db) }));
    registry.register(createTaskCancelTool({ queue: new JobQueue(db) }));
    registerM1Tools(registry, {
      vaultRegistry,
      version: "test",
      startedAt: 0,
      embeddings: { provider: "ollama", model: "nomic-embed-text" },
      metadataIndex,
      reindex: noop,
      deindex: noop,
    });
    registerM2Tools(registry, {
      vaultRegistry,
      embeddingProvider,
      dataviewBridge: bridge,
      regexTimeoutMs: 1000,
      metadataIndex,
      representation: buildRepresentationManifest(embeddingProvider, {}),
    });
    registerM3Tools(registry, { vaultRegistry, reindex: noop, templaterBridge: bridge });
    registerM4Tools(registry, {
      reindex: noop,
      vaultRegistry,
      capabilities: (() => ({})) as never,
      bridgeFor: () => undefined,
      timeouts: (() => ({})) as never,
      commandPolicy: () => ({ enabled: false, allowlist: [] }),
      mode: () => "headless",
    });
    registerM5Tools(registry, {
      cacheDir: "",
      vaultRegistry,
      activeSessions: {} as never,
      reindex: noop,
      plur: {} as never,
      memoryFolder: () => "memory",
      traceFolder: () => "workspace",
    });
    registerM6Tools(registry, {
      vaultRegistry,
      rateLimiter,
      version: "test",
      startedAt: 0,
      authMode: "none",
      throttle: {} as never,
      observability: { otel: false, prometheus: false, morgiana: true },
      embeddingsProvider: "ollama",
      governorMaxResponseBytes: 1e6,
      capabilities: (() => ({})) as never,
      registeredTools: () => registry.list().length,
      reindex: noop,
      deindex: noop,
    });
    registerM7Tools(registry, {
      vaultRegistry,
      embeddingProvider,
      reranker: {} as never,
      roles: {} as never,
    });
    registerM8Tools(registry, {});

    // A mutating tool that names a path (pathAcl) may write a note, as may the known pathless writers.
    const defs = registry.list();
    const declaresConventions = (t: { outputSchema?: unknown }): boolean => {
      const shape = (t.outputSchema as { shape?: Record<string, unknown> } | undefined)?.shape;
      return shape !== undefined && Object.hasOwn(shape, "conventions");
    };
    const writers = defs
      .filter(
        (t) =>
          isMutatingCall(t) &&
          (t.pathAcl !== undefined || NOTE_WRITERS_WITHOUT_PATH_ACL.has(t.name)),
      )
      .map((t) => t.name)
      .sort();
    const uncovered = defs
      .filter((t) => writers.includes(t.name))
      .filter((t) => {
        return (
          !declaresConventions(t) &&
          !CONVENTIONS_PENDING.has(t.name) &&
          !CONVENTIONS_EXEMPT.has(t.name)
        );
      })
      .map((t) => t.name);
    // A listed name that is no longer a mutating note writer is stale: it would hide a real gap later.
    const stale = [...CONVENTIONS_PENDING, ...CONVENTIONS_EXEMPT.keys()].filter(
      (n) => !writers.includes(n),
    );
    // A tool both pending and declaring is wired: it belongs in neither list any more.
    const both = defs
      .filter((t) => CONVENTIONS_PENDING.has(t.name) && declaresConventions(t))
      .map((t) => t.name)
      .sort();
    expect({ uncovered, stale, both }).toEqual({ uncovered: [], stale: [], both: [] });
  });
});
