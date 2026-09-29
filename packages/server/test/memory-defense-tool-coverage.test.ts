// Registry-driven inventory gate — every MUTATING tool (destructive, or carrying a mutating
// scope) must be accounted for as either scanned by memoryDefense (MEMORY_DEFENSE_COVERED) or a
// documented non-note-content exemption (MEMORY_DEFENSE_EXEMPT). A new writer that lands in
// neither set fails this test — same "enumerate from the registry, not a hand list" shape as
// acl-extraction-coverage.test.ts's EXEMPT_NO_PATH gate, which this file's registry
// assembly mirrors verbatim (registration only builds tool definitions; no live backend needed).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMutatingScope } from "@the-40-thieves/obsidian-tc-shared";
import { afterAll, describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { buildRepresentationManifest } from "../src/search/representation";
import { RateLimiter } from "../src/throttle";
import { createHealthTool } from "../src/tools/admin/health";
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
import { rmTemp } from "./tmp";

const NO_THROTTLE = {
  read: { perMinute: 1e6, burst: 1e6 },
  write: { perMinute: 1e6, burst: 1e6 },
  bulk: { perMinute: 1e6, burst: 1e6 },
  execute: { perMinute: 1e6, burst: 1e6 },
  admin: { perMinute: 1e6, burst: 1e6 },
};

// Every note-content writer that routes a caller-influenced field through memoryDefense before
// persisting — via PR #1015 (write_note/append_note/patch_note, move_note/copy_note,
// update_frontmatter/add_tag/remove_tag, rewrite_link/prune_hub_links, start_session/end_session,
// and the 7 structured memory tools) or this follow-up round (bulk_create_notes/
// bulk_set_property/bulk_move_notes, restore_note, update_task, the 4 GFM table tools, the 3
// periodic-note tools, move_attachment). `reflect` also scans its persist:true path (this same
// follow-up round, vault/persist-note.ts) but is not `destructive`/mutating-scoped by declaration
// (requiredScopes is read:notes; the write:notes check is handler-side, gated on `persist: true`)
// and so is not enumerated by the filter below — covered by test/reflect-persist-governed.test.ts
// and memory-defense.test.ts instead.
const MEMORY_DEFENSE_COVERED = new Set<string>([
  // PR #1015
  "write_note",
  "append_note",
  "patch_note",
  "move_note",
  "copy_note",
  "update_frontmatter",
  "add_tag",
  "remove_tag",
  "rewrite_link",
  "prune_hub_links",
  "start_session",
  "end_session",
  "create_entity",
  "add_observation",
  "enqueue_capture",
  "commit_capture",
  "set_goal",
  "link_entities",
  "rename_entity",
  // This follow-up round
  "bulk_create_notes",
  "bulk_set_property",
  "bulk_move_notes",
  "restore_note",
  "update_task",
  "format_table",
  "insert_table_row",
  "insert_table_column",
  "sort_table_by_column",
  "create_periodic_note",
  "find_or_create_periodic_note",
  "append_to_periodic_note",
  // Review finding: rewriteAttachmentReferences rewrites referencing notes' BODIES (the link
  // text), not just the binary attachment file, so it needs the same guard every other backlink
  // rewrite gets (move_note/bulk_move_notes' own rewriteForMoves).
  "move_attachment",
]);

// Mutating tools that write NO new caller-influenced free text into the vault, so there is nothing
// for memoryDefense to scan. Each entry is a deliberate, documented exemption — NOT a gap. Keep
// this list tight; a tool that DOES persist caller-supplied content must move to
// MEMORY_DEFENSE_COVERED (with a test) instead of being parked here.
const MEMORY_DEFENSE_EXEMPT = new Map<string, string>([
  // --- Structured Obsidian-app config (JSON via formats/json-config.ts), not a vault NOTE.
  ["add_bookmark", "writes .obsidian/bookmarks.json, not note content"],
  ["remove_bookmark", "writes .obsidian/bookmarks.json, not note content"],
  ["save_workspace", "writes .obsidian/workspaces.json, not note content"],
  ["open_workspace", "writes .obsidian/workspace.json (active layout), not note content"],
  // --- Structured-document formats (canvas/base/excalidraw/kanban): share writeNoteAtomic with
  //     the note writers above but were NOT in this round's named scope (table-tools WAS, and is
  //     in MEMORY_DEFENSE_COVERED above) — a documented residual for a follow-up round, not
  //     silently dropped. See the PR body's residuals section.
  ["create_canvas", "structured-document format (JSON); residual, see PR body"],
  ["update_canvas", "structured-document format (JSON); residual, see PR body"],
  ["create_base", "structured-document format (JSON); residual, see PR body"],
  ["update_base", "structured-document format (JSON); residual, see PR body"],
  ["create_excalidraw", "structured-document format (JSON); residual, see PR body"],
  ["update_excalidraw", "structured-document format (JSON); residual, see PR body"],
  ["add_kanban_card", "structured-document format (Markdown board); residual, see PR body"],
  ["move_kanban_card", "structured-document format (Markdown board); residual, see PR body"],
  // --- Binary attachments: no free-text content to scan.
  ["delete_attachment", "binary attachment op, no text content"],
  // --- Deletion / state-transition: no NEW caller-supplied free text persisted.
  ["delete_note", "removes a note; persists no new content"],
  ["delete_entity", "trashes the entity's computed note; persists no new content"],
  ["unlink_entities", "re-materializes the source entity's EXISTING (already-scanned) note"],
  ["close_goal", "moves a goals row to a terminal state; no free-text field"],
  ["work_forget", "deletion propagation in the experiential store; persists no new content"],
  [
    "work_result",
    "stamps a -1|0|+1 verdict + timestamp on the caller's OWN episode; no free-text field",
  ],
  [
    "record_retrieval_feedback",
    "stamps a feedback flag on an experiential retrieval-log row; no free-text field",
  ],
  ["reset_vault_cache", "drops cache rows; no vault write"],
  // --- Bridge dispatch into a running Obsidian: the PLUGIN performs the write; no server-side
  //     writeNoteAtomic call for this process's memoryDefense guard to sit in front of.
  ["execute_command", "plugin-side action via the companion bridge; no server-side vault write"],
  ["trigger_quickadd", "plugin-side action via the companion bridge; no server-side vault write"],
  [
    "remotely_save_trigger",
    "plugin-side action via the companion bridge; no server-side vault write",
  ],
  [
    "execute_template",
    "Templater (the plugin) expands + writes the note via the companion bridge; no server-side writeNoteAtomic call",
  ],
  // --- Git companion bridge: no vault FILE write through this process's ACL/memoryDefense surface.
  ["git_commit", "commits the already-staged index via the git bridge; no vault file write here"],
  ["git_stage", "stages files via the git bridge; no vault file write here"],
]);

describe("memoryDefense tool-coverage inventory", () => {
  const root = mkdtempSync(join(tmpdir(), "obtc-memdef-cov-"));
  afterAll(() => rmTemp(root));

  function buildRegistry(): ToolRegistry {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const vaultRegistry = new VaultRegistry([{ id: "t", name: "t", path: root }]);
    const rateLimiter = new RateLimiter(NO_THROTTLE as never);
    const registry = new ToolRegistry({ rateLimiter });
    const noop = () => {};
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
    return registry;
  }

  it("every mutating tool is either memoryDefense-covered or a documented non-note-content exemption", () => {
    const registry = buildRegistry();
    const mutating = registry
      .list()
      .filter((d) => d.destructive === true || d.requiredScopes.some(isMutatingScope));
    expect(
      mutating.length,
      "sanity: the registry produced no mutating tools at all",
    ).toBeGreaterThan(0);
    const unaccounted = mutating
      .map((d) => d.name)
      .filter((name) => !MEMORY_DEFENSE_COVERED.has(name) && !MEMORY_DEFENSE_EXEMPT.has(name))
      .sort();
    expect(
      unaccounted,
      `mutating tool(s) with no memoryDefense coverage AND no documented exemption: ${unaccounted.join(", ")}`,
    ).toEqual([]);
  });

  it("MEMORY_DEFENSE_COVERED and MEMORY_DEFENSE_EXEMPT name only tools that are actually registered", () => {
    const registry = buildRegistry();
    const byName = new Set(registry.list().map((d) => d.name));
    for (const name of MEMORY_DEFENSE_COVERED)
      expect(byName.has(name), `MEMORY_DEFENSE_COVERED names an unregistered tool: ${name}`).toBe(
        true,
      );
    for (const name of MEMORY_DEFENSE_EXEMPT.keys())
      expect(byName.has(name), `MEMORY_DEFENSE_EXEMPT names an unregistered tool: ${name}`).toBe(
        true,
      );
  });

  it("MEMORY_DEFENSE_COVERED and MEMORY_DEFENSE_EXEMPT do not overlap", () => {
    const overlap = [...MEMORY_DEFENSE_COVERED].filter((n) => MEMORY_DEFENSE_EXEMPT.has(n));
    expect(overlap, `tool(s) listed as both covered and exempt: ${overlap.join(", ")}`).toEqual([]);
  });
});
