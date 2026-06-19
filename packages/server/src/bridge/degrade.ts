// Degradation gate for bridge tools (M4 / THE-180). Every plugin-proxy tool calls
// requirePlugin before touching the bridge: the companion or target plugin being
// absent degrades to plugin_missing, a companion that did not answer degrades to
// plugin_unreachable, and an available plugin returns its reported version. Only
// the plugin name (never a token) is surfaced in the error details.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { type CapabilitySnapshot, pluginStatus } from "./capabilities";

export function requirePlugin(snap: CapabilitySnapshot, plugin: string): { version?: string } {
  const status = pluginStatus(snap, plugin);
  if (status.kind === "available")
    return status.version !== undefined ? { version: status.version } : {};
  if (status.kind === "plugin_unreachable")
    throw err.pluginUnreachable("plugin bridge unreachable", { plugin });
  throw err.pluginMissing(
    status.reason === "companion_missing"
      ? "companion plugin not detected"
      : "required Obsidian plugin not detected",
    { plugin, reason: status.reason },
  );
}
