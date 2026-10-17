import type { Hono } from "hono";
import { isHostAllowed } from "./host-guard";

export function mountHealthz(
  app: Hono,
  opts: { enableDnsRebindingProtection?: boolean; allowedHosts?: readonly string[] },
): void {
  app.get("/healthz", (c) => {
    if (
      opts.enableDnsRebindingProtection !== false &&
      !isHostAllowed(c.req.header("host") ?? "", opts.allowedHosts)
    )
      return c.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "host not allowed" }, id: null },
        403,
      );

    c.header("Cache-Control", "no-store");
    return c.json({ status: "ok" });
  });
}
