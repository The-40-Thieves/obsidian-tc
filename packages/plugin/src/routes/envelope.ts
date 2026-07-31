// The bridge envelope the server's transport expects — success: { ok: true, result },
// failure: { ok: false, code, message, details? } — plus the request-parsing helpers every
// handler uses to read it (WP6.1 extraction from routes.ts). Applied ONCE: every route-family
// module (probe.ts, commands.ts, git.ts, remotely-save.ts, and the families still inline in
// routes.ts) returns raw handlers; only the facade's `buildRoutes` wraps the assembled table
// with `safeHandler`, so no family re-wraps its own.
import type { BridgeReq, BridgeRes, RouteHandler } from "./types";

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
