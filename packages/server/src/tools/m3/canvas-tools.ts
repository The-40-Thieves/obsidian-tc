// Domain 8 — Canvas (.canvas), JSONCanvas spec. Four tools: read_canvas,
// create_canvas, update_canvas, query_canvas. Every path-based handler funnels
// through resolveVaultPath (containment -> path_invalid) + enforcePathAcl
// (whitelist -> acl_denied). Writes are content-addressed (optional prev_hash CAS
// -> concurrent_modification) and round-trip safe: updates merge into the parsed
// object in place so unknown node/edge/top-level fields survive. Confirmation is
// conditional: overwriting an existing canvas and removing >10 nodes require a HITL
// elicit token; ordinary creates and edits do not.
import {
  err,
  Pagination,
  VaultId,
  VaultPath,
  WriteOptions,
} from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import {
  CanvasDoc,
  CanvasEdge,
  CanvasNode,
  CanvasNodeType,
  parseCanvas,
  projectEdge,
  projectNode,
  serializeCanvas,
} from "../../formats/canvas";
import { detectJsonIndent } from "../../formats/json-config";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { readableRel } from "../../vault/acl-read-filter";
import { requireConfirmation } from "../../vault/hitl";
import { noteExists, readNote, writeNoteAtomic } from "../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath, walkVault } from "../../vault/paths";
import { defineTool } from "../m1/define";
import type { M3Deps } from "./index";

function requireCanvasExt(rel: string): void {
  if (!rel.toLowerCase().endsWith(".canvas"))
    throw err.invalidInput("path must be a .canvas file", { path: rel });
}

const NodeArray = z.array(CanvasNode);
const EdgeArray = z.array(CanvasEdge);
const PartialById = z.record(z.string(), z.record(z.string(), z.unknown()));

const CreateInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    nodes: NodeArray.default([]),
    edges: EdgeArray.default([]),
    overwrite: z.boolean().default(false),
    options: WriteOptions.prefault({}),
  })
  .strict();

const UpdateInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    add_nodes: NodeArray.optional(),
    add_edges: EdgeArray.optional(),
    remove_node_ids: z.array(z.string()).optional(),
    remove_edge_ids: z.array(z.string()).optional(),
    update_nodes: PartialById.optional(),
    update_edges: PartialById.optional(),
    prev_hash: z.string().optional(),
  })
  .strict();

const QueryInput = z
  .object({
    vault: VaultId,
    paths: z.array(VaultPath).optional(),
    root: VaultPath.optional(),
    filter: z
      .object({
        type: CanvasNodeType.optional(),
        color: z.string().optional(),
        file_path_contains: z.string().optional(),
        text_contains: z.string().optional(),
        has_edge_to: z.string().optional(),
      })
      .prefault({}),
  })
  .merge(Pagination)
  .strict();

export function buildCanvasTools(deps: M3Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "read_canvas",
      description: "Parse a .canvas file into its nodes and edges (JSONCanvas spec).",
      inputSchema: z.object({ vault: VaultId, path: VaultPath }).strict(),
      requiredScopes: ["read:canvas"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        requireCanvasExt(rel);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "read", rel, v.root);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("canvas not found", { path: rel });
        const { raw, hash } = readNote(abs);
        const parsed = parseCanvas(raw);
        return {
          vault: v.id,
          path: rel,
          nodes: parsed.nodes.map(projectNode),
          edges: parsed.edges.map(projectEdge),
          node_count: parsed.nodes.length,
          edge_count: parsed.edges.length,
          content_hash: hash,
        };
      },
    }),

    defineTool({
      name: "create_canvas",
      description:
        "Create a new .canvas with optional initial nodes/edges. Overwriting an existing canvas requires confirmation.",
      inputSchema: CreateInput,
      requiredScopes: ["write:canvas"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        requireCanvasExt(rel);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "write", rel, v.root);
        const ex = noteExists(abs);
        if (ex.exists && ex.type === "folder")
          throw err.invalidInput("path is a folder", { path: rel });
        if (ex.exists && !input.overwrite)
          throw err.noteExists("canvas already exists; set overwrite", { path: rel });
        requireConfirmation(ctx, "create_canvas", input, ex.exists && input.overwrite, {
          path: rel,
        });
        const doc: Record<string, unknown> = { nodes: input.nodes, edges: input.edges };
        const content = serializeCanvas(doc);
        writeNoteAtomic(abs, content, input.options.create_dirs);
        return {
          vault: v.id,
          path: rel,
          created: !ex.exists,
          node_count: input.nodes.length,
          edge_count: input.edges.length,
          content_hash: contentHash(content),
        };
      },
    }),

    defineTool({
      name: "update_canvas",
      description:
        "Patch a .canvas: add/remove/update nodes and edges by id. Unknown fields are preserved. Removing more than 10 nodes requires confirmation.",
      inputSchema: UpdateInput,
      requiredScopes: ["write:canvas"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        requireCanvasExt(rel);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "write", rel, v.root);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("canvas not found", { path: rel });
        const { raw: text, hash } = readNote(abs);
        if (input.prev_hash !== undefined && input.prev_hash !== hash)
          throw err.concurrentModification("canvas changed since prev_hash", {
            path: rel,
            expected: input.prev_hash,
            actual: hash,
          });
        const removeNodeCount = input.remove_node_ids?.length ?? 0;
        requireConfirmation(ctx, "update_canvas", input, removeNodeCount > 10, {
          path: rel,
          remove_node_count: removeNodeCount,
        });

        const indent = detectJsonIndent(text);
        const parsed = parseCanvas(text);
        const applied = {
          nodes_added: 0,
          nodes_removed: 0,
          nodes_updated: 0,
          edges_added: 0,
          edges_removed: 0,
          edges_updated: 0,
        };

        if (input.remove_node_ids?.length) {
          const set = new Set(input.remove_node_ids);
          const before = (parsed.raw.nodes as Record<string, unknown>[]).length;
          const kept = (parsed.raw.nodes as Record<string, unknown>[]).filter(
            (n) => !set.has(String(n.id)),
          );
          applied.nodes_removed = before - kept.length;
          parsed.raw.nodes = kept;
        }
        if (input.remove_edge_ids?.length) {
          const set = new Set(input.remove_edge_ids);
          const before = (parsed.raw.edges as Record<string, unknown>[]).length;
          const kept = (parsed.raw.edges as Record<string, unknown>[]).filter(
            (e) => !set.has(String(e.id)),
          );
          applied.edges_removed = before - kept.length;
          parsed.raw.edges = kept;
        }
        if (input.update_nodes) {
          for (const [id, patch] of Object.entries(input.update_nodes)) {
            const node = (parsed.raw.nodes as Record<string, unknown>[]).find(
              (n) => String(n.id) === id,
            );
            if (node) {
              Object.assign(node, patch);
              applied.nodes_updated++;
            }
          }
        }
        if (input.update_edges) {
          for (const [id, patch] of Object.entries(input.update_edges)) {
            const edge = (parsed.raw.edges as Record<string, unknown>[]).find(
              (e) => String(e.id) === id,
            );
            if (edge) {
              Object.assign(edge, patch);
              applied.edges_updated++;
            }
          }
        }
        if (input.add_nodes?.length) {
          (parsed.raw.nodes as Record<string, unknown>[]).push(
            ...(input.add_nodes as Record<string, unknown>[]),
          );
          applied.nodes_added = input.add_nodes.length;
        }
        if (input.add_edges?.length) {
          (parsed.raw.edges as Record<string, unknown>[]).push(
            ...(input.add_edges as Record<string, unknown>[]),
          );
          applied.edges_added = input.add_edges.length;
        }

        const check = CanvasDoc.safeParse(parsed.raw);
        if (!check.success)
          throw err.invalidInput("resulting canvas is invalid", { issues: check.error.issues });
        const content = serializeCanvas(parsed.raw, indent);
        writeNoteAtomic(abs, content, false);
        return {
          vault: v.id,
          path: rel,
          applied,
          content_hash: contentHash(content),
          prev_hash: hash,
        };
      },
    }),

    defineTool({
      name: "query_canvas",
      description:
        "Find nodes matching criteria across one or more .canvas files (defaults to all canvases under the vault root).",
      inputSchema: QueryInput,
      requiredScopes: ["read:canvas"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const sub = input.root ? normalizeVaultPath(input.root) : undefined;
        if (sub) enforcePathAcl(ctx.acl, "read", sub, v.root);
        const canvasPaths = input.paths?.length
          ? input.paths
              .map(normalizeVaultPath)
              .filter((p) => p.toLowerCase().endsWith(".canvas") && readableRel(ctx.acl, p))
          : walkVault(v.root, { sub, extensions: [".canvas"] })
              .map((e) => e.relPath)
              .filter((p) => readableRel(ctx.acl, p));

        const f = input.filter;
        const items: Array<{
          canvas_path: string;
          node_id: string;
          type: string;
          snippet?: string;
        }> = [];
        const errors: Array<{ path: string; code: string }> = [];
        for (const cp of canvasPaths) {
          const abs = resolveVaultPath(v.root, cp);
          if (!noteExists(abs).exists) {
            errors.push({ path: cp, code: "note_not_found" });
            continue;
          }
          let parsed: ReturnType<typeof parseCanvas>;
          try {
            parsed = parseCanvas(readNote(abs).raw);
          } catch {
            errors.push({ path: cp, code: "invalid_input" });
            continue;
          }
          const edges = parsed.edges as Record<string, unknown>[];
          for (const node of parsed.nodes as Record<string, unknown>[]) {
            if (f.type && node.type !== f.type) continue;
            if (f.color && node.color !== f.color) continue;
            if (f.file_path_contains && !String(node.file ?? "").includes(f.file_path_contains))
              continue;
            if (f.text_contains && !String(node.text ?? "").includes(f.text_contains)) continue;
            if (
              f.has_edge_to &&
              !edges.some(
                (e) => String(e.fromNode) === String(node.id) && String(e.toNode) === f.has_edge_to,
              )
            )
              continue;
            const snippet =
              node.text !== undefined
                ? String(node.text).slice(0, 140)
                : node.file !== undefined
                  ? String(node.file)
                  : undefined;
            items.push({
              canvas_path: cp,
              node_id: String(node.id),
              type: String(node.type),
              ...(snippet !== undefined ? { snippet } : {}),
            });
          }
        }

        const limit = input.limit ?? 50;
        const start = input.cursor ? Math.max(0, Number.parseInt(input.cursor, 10) || 0) : 0;
        const page = items.slice(start, start + limit);
        const nextStart = start + page.length;
        const next = nextStart < items.length ? String(nextStart) : undefined;
        return {
          vault: v.id,
          total: items.length,
          items: page,
          canvases_scanned: canvasPaths.length,
          errors,
          ...(next ? { next_cursor: next } : {}),
        };
      },
    }),
  ];
}
