// THE-527 — refresh_plugin_capabilities.
//
// reload_vault re-reads the config file but does NOT re-probe, so the capability snapshot taken once
// at startup goes stale the moment a plugin is installed/enabled or the companion is upgraded —
// requiring a full server restart even though the bridge is up and would answer a probe immediately.
// This tool re-fires the probe for one vault and swaps the cached snapshot atomically, reporting what
// changed rather than a bare ok.
//
// Deliberately narrower than a full hot-config reload: it re-reads DISCOVERED state (the probe), not
// DECLARED state, so it sidesteps the hard part (rebinding transports/ACLs/storage) while covering
// the case that actually changes during a session.
import { err, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { CapabilitySnapshot } from "../../bridge/capabilities";
import type { ToolDefinition } from "../../mcp/registry";
import { defineTool } from "../m1/define";
import type { M4Deps } from "./shared";

export interface SnapshotChange {
  field: string;
  before: string;
  after: string;
}

function pluginRepr(cap: { installed: boolean; version?: string } | undefined): string {
  if (!cap) return "absent";
  const state = cap.installed ? "installed" : "not-installed";
  return cap.version ? `${state}@${cap.version}` : state;
}

/**
 * Diff two capability snapshots into a flat, human-readable change list. Covers the companion state,
 * its reported plugin/API versions, and every plugin that was added, removed, or whose
 * installed-state/version changed. An empty list means the refresh was a no-op.
 */
export function diffSnapshots(
  before: CapabilitySnapshot,
  after: CapabilitySnapshot,
): SnapshotChange[] {
  const changes: SnapshotChange[] = [];

  if (before.companion !== after.companion) {
    changes.push({ field: "companion", before: before.companion, after: after.companion });
  }
  for (const field of ["pluginVersion", "obsidianVersion", "apiVersion", "apiCompat"] as const) {
    const b = before[field];
    const a = after[field];
    if (b !== a) changes.push({ field, before: b ?? "(none)", after: a ?? "(none)" });
  }

  const names = new Set([...Object.keys(before.plugins), ...Object.keys(after.plugins)]);
  for (const name of [...names].sort()) {
    const b = pluginRepr(before.plugins[name]);
    const a = pluginRepr(after.plugins[name]);
    if (b !== a) changes.push({ field: `plugin:${name}`, before: b, after: a });
  }

  return changes;
}

/** THE-527 tool factory: refresh_plugin_capabilities (admin:vault, vault-scoped). */
export function buildCapabilityTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "refresh_plugin_capabilities",
      description:
        "Re-probe the companion plugin for a vault and atomically replace the cached capability snapshot, so installing/enabling a plugin or upgrading the companion takes effect WITHOUT a server restart. Returns what changed (companion state, plugin/version deltas), not a bare ok. Admin-scoped, no HITL.",
      inputSchema: z.object({ vault: VaultId }).strict(),
      requiredScopes: ["admin:vault"],
      handler: async (input, _ctx) => {
        if (!deps.reprobe) {
          throw err.invalidInput(
            "refresh_plugin_capabilities is not available: the server was started without a re-probe hook wired.",
          );
        }
        const before = deps.capabilities.get(input.vault);
        const after = await deps.reprobe(input.vault);
        // Atomic swap: a single set() replaces the whole snapshot; every subsequent bridge call reads
        // the new one. No partial state is ever observable.
        deps.capabilities.set(input.vault, after);

        const changes = diffSnapshots(before, after);
        return {
          vault: input.vault,
          changed: changes.length > 0,
          companion: after.companion,
          pluginCount: Object.values(after.plugins).filter((p) => p.installed).length,
          changes,
        };
      },
    }),
  ];
}
