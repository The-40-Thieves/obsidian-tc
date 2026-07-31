// Bridge protocol shapes plus the minimal duck-typed models of Obsidian/community-plugin
// internals not covered by the public `obsidian` d.ts (WP6.1 extraction from routes.ts).
// Shared across every route-family module: probe.ts, commands.ts, git.ts and
// remotely-save.ts import from here, and routes.ts (the facade for the families not yet
// extracted) does too — so nothing here may import from a route-family module or from
// routes.ts itself, or the split reintroduces the cycle it exists to avoid.
import type { App } from "obsidian";

export interface BridgeReq {
  body?: unknown;
  query?: Record<string, unknown>;
}
export interface BridgeRes {
  status(code: number): BridgeRes;
  json(body: unknown): void;
}
export type RouteHandler = (req: BridgeReq, res: BridgeRes) => void | Promise<void>;
export interface RouteDef {
  method: "get" | "post";
  path: string;
  handler: RouteHandler;
}

// --- Minimal models of Obsidian/community internals not in the public obsidian d.ts.
export interface CommunityPlugin {
  manifest?: { version?: string };
  api?: unknown;
  settings?: unknown;
}
export interface PluginRegistry {
  plugins: Record<string, CommunityPlugin | undefined>;
}
export interface CommandLite {
  id: string;
  name: string;
}
export interface CommandsRegistry {
  listCommands(): CommandLite[];
  executeCommandById(id: string): boolean;
}
// Core (internal) plugins live under app.internalPlugins, separate from community plugins.
export interface InternalPluginLite {
  enabled?: boolean;
  instance?: { options?: Record<string, unknown> };
}
export type InternalApp = App & {
  plugins?: PluginRegistry;
  commands?: CommandsRegistry;
  internalPlugins?: { plugins?: Record<string, InternalPluginLite | undefined> };
};

// Server capability key -> the community plugin's Obsidian id. The server addresses
// plugins by the left-hand name (e.g. "excalidraw"); the right-hand is the real id.
export const CAP_IDS: Record<string, string> = {
  excalidraw: "obsidian-excalidraw-plugin",
  dataview: "dataview",
  tasks: "obsidian-tasks-plugin",
  templater: "templater-obsidian",
  quickadd: "quickadd",
  "text-extractor": "text-extractor",
  "make-md": "make-md",
  omnisearch: "omnisearch",
  datacore: "datacore",
  "metadata-menu": "metadata-menu",
  git: "obsidian-git",
  "remotely-save": "remotely-save",
};

export function communityPlugin(app: InternalApp, capKey: string): CommunityPlugin | undefined {
  const id = CAP_IDS[capKey];
  return id ? app.plugins?.plugins?.[id] : undefined;
}

/** Access a core (internal) plugin by id, e.g. "daily-notes". */
export function internalPlugin(app: InternalApp, id: string): InternalPluginLite | undefined {
  return app.internalPlugins?.plugins?.[id];
}
