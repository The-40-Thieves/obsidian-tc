// Bridge route handlers for the obsidian-tc companion plugin (THE-180, G2.2 §3.1).
// Each handler returns the bridge envelope the server's transport expects:
//   success: { ok: true, result }   failure: { ok: false, code, message, details? }
// `/probe` and `/commands/*` run against deterministic Obsidian internals and are
// the load-bearing contract (the server's auto-probe + command palette depend on
// them). The community-plugin domain handlers (dataview/excalidraw/tasks/templater/
// quickadd/ocr/makemd) invoke each plugin's runtime API and are the MANUAL-
// verification surface: CI builds + typechecks this file, but their live behavior
// against installed community plugins is validated against a real vault, not in CI.
// Any absent API or thrown error degrades to a typed envelope the server already
// handles (plugin_missing / plugin_unreachable / invalid_input / dql_error).
//
// WP6.1 split the shared scaffolding plus probe/commands/git/remotely-save out to
// src/routes/{types,envelope,probe,commands,git,remotely-save}.ts. WP6.2 completed the split,
// moving the remaining 11 community-plugin integration families out to their own modules
// (src/routes/{dataview,quickadd,ocr,excalidraw,makemd,omnisearch,datacore,metadata-menu,
// daily-notes,templater,tasks}.ts). This file is now purely the FACADE: it re-exports the
// public types those modules define, and `buildRoutes` concatenates every family's routes in
// the same order as before the split. A `packages/plugin/test/route-table-snapshot.test.ts`
// pins that order plus every (method, path) pair and their uniqueness across the whole table.
import type { App } from "obsidian";
import { buildCommandsRoutes } from "./routes/commands";
import { buildDailyNotesRoutes } from "./routes/daily-notes";
import { buildDatacoreRoutes } from "./routes/datacore";
import { buildDataviewRoutes } from "./routes/dataview";
import { safeHandler } from "./routes/envelope";
import { buildExcalidrawRoutes } from "./routes/excalidraw";
import { buildGitRoutes } from "./routes/git";
import { buildMakemdRoutes } from "./routes/makemd";
import { buildMetadataMenuRoutes } from "./routes/metadata-menu";
import { buildOcrRoutes } from "./routes/ocr";
import { buildOmnisearchRoutes } from "./routes/omnisearch";
import { buildProbeRoutes } from "./routes/probe";
import { buildQuickAddRoutes } from "./routes/quickadd";
import { buildRemotelySaveRoutes } from "./routes/remotely-save";
import { buildTasksRoutes } from "./routes/tasks";
import { buildTemplaterRoutes } from "./routes/templater";
import type { InternalApp, RouteDef } from "./routes/types";

export type { BridgeReq, BridgeRes, RouteDef, RouteHandler } from "./routes/types";

export function buildRoutes(
  appArg: App,
  pluginVersion: string,
  shapeWarnings: string[] = [],
): RouteDef[] {
  const app = appArg as unknown as InternalApp;
  const defs: RouteDef[] = [
    ...buildProbeRoutes(app, pluginVersion, shapeWarnings),

    ...buildCommandsRoutes(app),

    ...buildGitRoutes(app),

    ...buildRemotelySaveRoutes(app),

    ...buildDataviewRoutes(app),

    ...buildQuickAddRoutes(app),

    ...buildOcrRoutes(app),

    ...buildExcalidrawRoutes(app),

    ...buildMakemdRoutes(app),

    ...buildOmnisearchRoutes(app),

    ...buildDatacoreRoutes(app),

    ...buildMetadataMenuRoutes(app),

    ...buildDailyNotesRoutes(app),

    ...buildTemplaterRoutes(app),

    ...buildTasksRoutes(app),
  ];
  return defs.map((d) => ({ ...d, handler: safeHandler(d.handler) }));
}
