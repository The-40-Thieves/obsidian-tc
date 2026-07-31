// GET /probe — deterministic capability discovery (WP6.1 extraction from routes.ts). This is
// how the server discovers plugin capabilities and negotiates the bridge-protocol version, so
// its output must stay byte-identical across the split: no field renamed, reordered, added, or
// dropped relative to the pre-extraction shape.
import { apiVersion } from "obsidian";
import { ok } from "./envelope";
import { CAP_IDS, type InternalApp, type RouteDef } from "./types";

/** Bridge protocol version reported by /probe (matches the server's expectation). */
const API_VERSION = "1";

function probeResult(app: InternalApp, pluginVersion: string, shapeWarnings: string[]): unknown {
  const capabilities: Record<string, { installed: boolean; version?: string }> = {};
  for (const [key, id] of Object.entries(CAP_IDS)) {
    const p = app.plugins?.plugins?.[id];
    capabilities[key] = p
      ? { installed: true, ...(p.manifest?.version ? { version: p.manifest.version } : {}) }
      : { installed: false };
  }
  return {
    plugin_version: pluginVersion,
    obsidian_version: apiVersion,
    obsidianTcApiVersion: API_VERSION,
    // getName() is the vault's display name, not its filesystem path; on desktop the
    // FileSystemAdapter exposes the real base path. Fall back to the name (e.g. on mobile).
    vault_path:
      (app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? app.vault.getName(),
    capabilities,
    // THE-282: startup shape self-check results (Obsidian internals this plugin duck-types).
    shape_ok: shapeWarnings.length === 0,
    ...(shapeWarnings.length ? { shape_warnings: shapeWarnings } : {}),
  };
}

export function buildProbeRoutes(
  app: InternalApp,
  pluginVersion: string,
  shapeWarnings: string[],
): RouteDef[] {
  return [
    {
      method: "get",
      path: "/probe",
      handler: (_req, res) => ok(res, probeResult(app, pluginVersion, shapeWarnings)),
    },
  ];
}
