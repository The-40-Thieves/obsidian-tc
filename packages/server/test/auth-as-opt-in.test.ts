import { afterEach, describe, expect, it } from "vitest";
import { cleanupFlows, makeFlow, rows } from "./as-flow-harness";

afterEach(cleanupFlows);

describe("DCR is opt-in", () => {
  it.each([undefined, false])(
    "unset or false (%s) exposes no registration surface",
    async (flag) => {
      const flow = await makeFlow({ as: flag === undefined ? {} : { dynamicRegistration: flag } });
      expect(flow.auth.as?.dynamicRegistration).toBe(false);
      const res = await flow.app.request(flow.url("/oauth/register"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://localhost/cb"] }),
      });
      expect(res.status).toBe(404);
      const meta = await (
        await flow.app.request(flow.url("/.well-known/oauth-authorization-server"))
      ).json();
      expect(meta).not.toHaveProperty("registration_endpoint");
      expect(rows(flow, "SELECT 1 FROM oauth_clients")).toHaveLength(0);
      expect(flow.logs.join("\n")).not.toMatch(/dynamic client registration/i);
    },
  );
});
