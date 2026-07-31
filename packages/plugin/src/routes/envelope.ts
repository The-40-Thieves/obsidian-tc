// The bridge envelope the server's transport expects — success: { ok: true, result },
// failure: { ok: false, code, message, details? } — plus the request-parsing helpers every
// handler uses to read it (WP6.1 extraction from routes.ts). Applied ONCE: every route-family
// module (probe.ts, commands.ts, git.ts, remotely-save.ts, and — WP6.2 — dataview.ts,
// quickadd.ts, ocr.ts, excalidraw.ts, makemd.ts, omnisearch.ts, datacore.ts,
// metadata-menu.ts, daily-notes.ts, templater.ts, tasks.ts) returns raw handlers; only the
// facade's `buildRoutes` wraps the assembled table with `safeHandler`, so no family re-wraps
// its own.
import {
  type BridgeReq,
  type BridgeRes,
  communityPlugin,
  type InternalApp,
  type RouteHandler,
} from "./types";

export const ok = (res: BridgeRes, result: unknown): void => {
  res.status(200).json({ ok: true, result });
};
export const fail = (
  res: BridgeRes,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void => {
  res.status(200).json({ ok: false, code, message, ...(details ? { details } : {}) });
};

// A handler that throws (or rejects) must still answer: LRA's express router does not
// catch async rejections, so an unanswered request hangs the bridge client until its
// timeout and surfaces as a cause-less plugin_unreachable. Every registered handler is
// wrapped at buildRoutes' boundary.
export const safeHandler = (h: RouteHandler): RouteHandler => {
  return async (req, res) => {
    try {
      await h(req, res);
    } catch (e) {
      try {
        fail(res, "bridge_error", e instanceof Error ? e.message : String(e));
      } catch {
        // response already committed — nothing more to send
      }
    }
  };
};

export const body = (req: BridgeReq): Record<string, unknown> =>
  typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
export const str = (o: Record<string, unknown>, k: string): string | undefined =>
  typeof o[k] === "string" ? (o[k] as string) : undefined;

// Resolve a community plugin's `api`, mapping absence onto the error taxonomy: the plugin not
// installed -> plugin_missing; installed but exposing no usable api -> plugin_unreachable.
// Returns the api on success, or null after sending the failure. Shared by every family that
// probes a community plugin's `api` (dataview, quickadd, ocr, makemd, omnisearch, datacore,
// metadata-menu — WP6.2) rather than duplicated per family.
export function requireApi<T>(app: InternalApp, res: BridgeRes, capKey: string): T | null {
  const plugin = communityPlugin(app, capKey);
  if (!plugin) {
    fail(res, "plugin_missing", `${capKey} is not installed`, { plugin: capKey });
    return null;
  }
  if (!plugin.api) {
    fail(res, "plugin_unreachable", `${capKey} exposes no programmatic API`, { plugin: capKey });
    return null;
  }
  return plugin.api as T;
}
