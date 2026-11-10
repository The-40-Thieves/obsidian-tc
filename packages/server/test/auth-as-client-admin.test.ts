import { afterEach, expect, it } from "vitest";
import { removeRegisteredClient } from "../src/auth/as-client-admin";
import { insertRegistration } from "../src/auth/as-dcr";
import {
  authorize,
  cleanupFlows,
  exchange,
  handleOf,
  issue,
  Jar,
  makeFlow,
  mcpPing,
  pkce,
  refreshFields,
} from "./as-flow-harness";
import { get } from "./as-operator-harness";

afterEach(cleanupFlows);

it("removal kills both token families at the HTTP edge and blocks pending and fresh sign-ins", async () => {
  const flow = await makeFlow({ as: { dynamicRegistration: true } });
  insertRegistration(flow.db, {
    clientId: "dcr_target",
    meta: {
      name: "Target",
      redirectUris: ["https://app.example/cb"],
      authMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
    },
    source: "test",
    now: flow.clock.t,
    maxClients: 100,
  });
  const over = { client_id: "dcr_target", redirect_uri: "https://app.example/cb" };
  const first = await issue(flow, over);
  const second = await issue(flow, over);
  const spared = await issue(flow);
  const waiting = await authorize(flow, new Jar(), pkce().challenge, over);
  const handle = handleOf(waiting.headers.get("location"));
  const result = removeRegisteredClient(
    flow.db,
    flow.registry,
    "dcr_target",
    "operator",
    flow.clock.t,
  );
  expect(result).toEqual({ status: "removed", grants: 1 });
  for (const token of [first, second]) {
    expect(await mcpPing(flow, token.access)).toBe(401);
    expect(
      (await exchange(flow, refreshFields(token.refresh, { client_id: "dcr_target" }))).res.status,
    ).toBe(401);
  }
  expect(await mcpPing(flow, spared.access)).toBe(200);
  expect((await get(flow, `/oauth/consent?request=${handle}`, new Jar())).text).toContain(
    "already completed",
  );
  const again = await authorize(flow, new Jar(), pkce().challenge, over);
  expect(again.status).toBe(400);
  expect(again.headers.get("location")).toBeNull();
});
