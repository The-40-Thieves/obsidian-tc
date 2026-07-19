// Domain: point-in-time snapshots (THE-374). Four tools over the content-addressed snapshot
// store: snapshot_note (manual capture), list_snapshots, read_snapshot, restore_note. Auto
// capture-on-write is wired in the notes/frontmatter handlers and gated by config.snapshots;
// these tools are always available (list/read/restore operate on whatever snapshots exist).
import { err, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { requireConfirmation } from "../../vault/hitl";
import { noteExists, readNote, writeNoteAtomic } from "../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath } from "../../vault/paths";
import { captureSnapshot, listSnapshots, readSnapshot } from "../../vault/snapshots";
import { defineTool } from "./define";
import type { M1Deps } from "./index";

export function buildSnapshotTools(deps: M1Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "snapshot_note",
      pathAcl: (input) => [{ op: "read", path: input.path }],
      description:
        "Capture the current content of a note as a restorable point-in-time snapshot (retained per config.snapshots.retention). Returns the snapshot id and content hash.",
      inputSchema: z.object({ vault: VaultId, path: VaultPath }).strict(),
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "read", rel, v.root);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("note not found", { path: rel });
        const { raw, hash } = readNote(abs);
        const id = captureSnapshot(
          ctx.db,
          { enabled: true, retention: deps.snapshots?.retention ?? 10 },
          v.id,
          rel,
          raw,
          "manual",
          ctx.now,
        );
        return { vault: v.id, path: rel, snapshot_id: id, content_hash: hash };
      },
    }),

    defineTool({
      name: "list_snapshots",
      pathAcl: (input) => [{ op: "read", path: input.path }],
      description:
        "List a note's point-in-time snapshots, newest first (id, op, content_hash, size, created_at).",
      inputSchema: z
        .object({
          vault: VaultId,
          path: VaultPath,
          limit: z.number().int().positive().max(500).default(50),
        })
        .strict(),
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "read", rel, v.root);
        const snapshots = listSnapshots(ctx.db, v.id, rel, input.limit);
        return { vault: v.id, path: rel, total: snapshots.length, snapshots };
      },
    }),

    defineTool({
      name: "read_snapshot",
      description: "Read the full stored content of a single snapshot by id.",
      inputSchema: z.object({ vault: VaultId, snapshot_id: z.number().int().positive() }).strict(),
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const snap = readSnapshot(ctx.db, v.id, input.snapshot_id);
        if (!snap) throw err.notFound("snapshot not found", { snapshot_id: input.snapshot_id });
        enforcePathAcl(ctx.acl, "read", snap.path, v.root);
        return { vault: v.id, ...snap };
      },
    }),

    defineTool({
      name: "restore_note",
      pathAcl: (input) => [{ op: "write", path: input.path }],
      description:
        "Restore a note to a prior snapshot's content. Destructive — overwrites the current note (whose current state is itself snapshotted first when snapshots are enabled, so the restore is reversible) and requires confirmation.",
      inputSchema: z
        .object({
          vault: VaultId,
          path: VaultPath,
          snapshot_id: z.number().int().positive(),
          prev_hash: z.string().optional(),
        })
        .strict(),
      requiredScopes: ["write:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "write", rel, v.root);
        const snap = readSnapshot(ctx.db, v.id, input.snapshot_id);
        if (!snap) throw err.notFound("snapshot not found", { snapshot_id: input.snapshot_id });
        if (snap.path !== rel)
          throw err.invalidInput("snapshot belongs to a different path", {
            snapshot_id: input.snapshot_id,
            snapshot_path: snap.path,
            path: rel,
          });
        const ex = noteExists(abs);
        if (ex.exists && ex.type === "folder")
          throw err.invalidInput("path is a folder", { path: rel });
        let prevHash: string | null = null;
        let prevRaw: string | null = null;
        if (ex.exists) {
          const cur = readNote(abs);
          prevHash = cur.hash;
          prevRaw = cur.raw;
          if (input.prev_hash !== undefined && input.prev_hash !== cur.hash)
            throw err.concurrentModification("note changed since prev_hash", {
              path: rel,
              expected: input.prev_hash,
              actual: cur.hash,
            });
        }
        // Validate first (bad snapshot/path -> invalid_input) THEN gate the destructive overwrite.
        requireConfirmation(ctx, "restore_note", input, true, {
          path: rel,
          restored_from: input.snapshot_id,
        });
        if (prevRaw !== null)
          captureSnapshot(ctx.db, deps.snapshots, v.id, rel, prevRaw, "restore_note", ctx.now);
        writeNoteAtomic(abs, snap.content, true);
        deps.reindex?.(v.id, rel, snap.content);
        return {
          vault: v.id,
          path: rel,
          restored: true,
          restored_from: input.snapshot_id,
          content_hash: contentHash(snap.content),
          prev_hash: prevHash,
        };
      },
    }),
  ];
}
