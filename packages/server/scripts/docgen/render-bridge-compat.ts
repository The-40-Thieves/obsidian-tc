// docgen — bridge-compat renderer (THE-470 hole 1). SUPPORTED_BRIDGE (src/bridge/version.ts) is the
// single source for the server<->companion version contract; this renders it into the marked table
// docs/wiki/Plugin-Bridges.md carries. Before this the region was hand-typed and asserted only by
// bridge-compat-docs.test.ts — a vitest failure catches drift AFTER a bump, but nothing generated the
// table, so it was invisible to docgen:render, the drift gate, and the prose watcher.
import { SUPPORTED_BRIDGE } from "../../src/bridge/version";

export function renderBridgeCompat(bridge: typeof SUPPORTED_BRIDGE = SUPPORTED_BRIDGE): string {
  return [
    "| Contract axis | Supported minimum |",
    "|---|---|",
    `| Companion plugin version | \`${bridge.minPluginVersion}\` |`,
    `| Obsidian app version (\`minAppVersion\`) | \`${bridge.minObsidianVersion}\` |`,
    `| Companion API major | \`${bridge.expectedApi}\` |`,
  ].join("\n");
}
