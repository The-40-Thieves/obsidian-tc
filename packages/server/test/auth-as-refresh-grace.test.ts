// The reuse grace of a rotated refresh token (`auth.as.refreshReuseGraceSeconds`). Clients such as Zed,
// Claude Code and Gemini CLI refresh from several windows or processes that share one refresh token, so a
// second refresh with the token the family just left is a race and not a theft: inside the grace it is
// answered with the SAME successor and access token, outside it (or older, or from another client) it is
// still a reuse. Rotation itself is unchanged.
import { decodeJwt } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupFlows,
  exchange,
  type Flow,
  issue,
  LOOPBACK_CLIENT,
  makeFlow,
  mcpPing,
  refreshFields,
  rows,
} from "./as-flow-harness";

afterEach(cleanupFlows);

const refresh = (flow: Flow, rt: string, over: Record<string, string | undefined> = {}) =>
  exchange(flow, refreshFields(rt, over));

async function next(flow: Flow, rt: string) {
  const { res, body } = await refresh(flow, rt);
  expect(res.status, JSON.stringify(body)).toBe(200);
  return { access: body.access_token as string, refresh: body.refresh_token as string, body };
}

const familyRows = (flow: Flow) =>
  rows<{ revoked_at: number | null }>(flow, "SELECT revoked_at FROM refresh_tokens");
const alive = (flow: Flow): boolean => familyRows(flow).every((r) => r.revoked_at === null);
const SECOND = 1000;

describe("grace: the token the family just left", () => {
  it("a second window refreshing the stale token after the first moved on gets the SAME pair, and no branch", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh); // window 1 rotates a -> b
    const c = await next(flow, b.refresh); // the family moves on: a is now stale
    flow.clock.t += 5 * SECOND;
    const late = await next(flow, a.refresh); // window 2 still holds a
    expect(late.refresh).toBe(b.refresh);
    expect(late.access).toBe(b.access);
    expect(decodeJwt(late.access).jti).toBe(decodeJwt(b.access).jti);
    expect(familyRows(flow)).toHaveLength(3); // a, b, c: no branch
    expect(alive(flow)).toBe(true);
    expect(await mcpPing(flow, c.access)).toBe(200);
    expect(await mcpPing(flow, late.access)).toBe(200);
    // ...and the late window converges on the family's head instead of forking it.
    const again = await next(flow, late.refresh);
    expect(again.refresh).toBe(c.refresh);
    expect(familyRows(flow)).toHaveLength(3);
  });

  it("concurrent refreshes with one token all succeed with one successor", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const all = await Promise.all([refresh(flow, a.refresh), refresh(flow, a.refresh)]);
    expect(all.map((r) => r.res.status)).toEqual([200, 200]);
    expect(new Set(all.map((r) => r.body.refresh_token)).size).toBe(1);
    expect(new Set(all.map((r) => r.body.access_token)).size).toBe(1);
    expect(familyRows(flow)).toHaveLength(2);
    expect(alive(flow)).toBe(true);
  });

  it("after the window the token is a reuse: invalid_grant and the family is revoked", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    const c = await next(flow, b.refresh);
    flow.clock.t += 31 * SECOND;
    const late = await refresh(flow, a.refresh);
    expect(late.body.error).toBe("invalid_grant");
    expect(familyRows(flow).every((r) => r.revoked_at !== null)).toBe(true);
    expect(await mcpPing(flow, c.access)).toBe(401);
  });

  it("the window is the configured one", async () => {
    const flow = await makeFlow({ as: { refreshReuseGraceSeconds: 5 } });
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    await next(flow, b.refresh);
    flow.clock.t += 4 * SECOND;
    expect((await refresh(flow, a.refresh)).res.status).toBe(200);
    flow.clock.t += 2 * SECOND;
    expect((await refresh(flow, a.refresh)).body.error).toBe("invalid_grant");
    expect(alive(flow)).toBe(false);
  });

  it("a clock that steps backward does not open a grace: grace 0 stays strict, a closed window stays closed", async () => {
    const strict = await makeFlow({ as: { refreshReuseGraceSeconds: 0 } });
    const a0 = await issue(strict);
    const b0 = await next(strict, a0.refresh);
    await next(strict, b0.refresh);
    strict.clock.t -= 10 * SECOND;
    expect((await refresh(strict, a0.refresh)).body.error).toBe("invalid_grant");
    expect(alive(strict)).toBe(false);

    const flow = await makeFlow({ as: { refreshReuseGraceSeconds: 5 } });
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    await next(flow, b.refresh);
    flow.clock.t -= 10 * SECOND;
    expect((await refresh(flow, a.refresh)).body.error).toBe("invalid_grant");
    expect(alive(flow)).toBe(false);
  });

  it("a token two generations back is a reuse even inside the window", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    const c = await next(flow, b.refresh);
    const d = await next(flow, c.refresh);
    expect((await refresh(flow, a.refresh)).body.error).toBe("invalid_grant");
    expect(alive(flow)).toBe(false);
    expect(await mcpPing(flow, d.access)).toBe(401);
  });

  it("a graced replay is a reuse once the family moved on past the successor too: the family is revoked", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    const c = await next(flow, b.refresh);
    expect((await refresh(flow, a.refresh)).res.status).toBe(200); // graced: b again
    const d = await next(flow, c.refresh); // ...then the successor's successor is used
    expect(d.refresh).not.toBe(c.refresh);
    await next(flow, d.refresh);
    expect((await refresh(flow, a.refresh)).body.error).toBe("invalid_grant");
    expect(alive(flow)).toBe(false);
  });

  it("a graced replay never mints: the family keeps one row per generation", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    await next(flow, b.refresh);
    const before = rows<{ n: number }>(flow, "SELECT COUNT(*) AS n FROM issued_access")[0]?.n;
    for (let i = 0; i < 3; i++) expect((await refresh(flow, a.refresh)).res.status).toBe(200);
    expect(rows<{ n: number }>(flow, "SELECT COUNT(*) AS n FROM issued_access")[0]?.n).toBe(before);
    expect(familyRows(flow)).toHaveLength(3);
  });

  it("another client presenting the stale token gets nothing and revokes nothing", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    await next(flow, b.refresh);
    const other = await refresh(flow, a.refresh, { client_id: LOOPBACK_CLIENT });
    expect(other.res.status).toBe(400);
    expect(other.body.error).toBe("invalid_grant");
    expect(other.body.refresh_token).toBeUndefined();
    expect(alive(flow)).toBe(true);
  });

  it("grace 0 is the old behaviour: the token is a reuse the moment its successor is used", async () => {
    const flow = await makeFlow({ as: { refreshReuseGraceSeconds: 0 } });
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    expect((await refresh(flow, a.refresh)).body.refresh_token).toBe(b.refresh); // the old retry
    const c = await next(flow, b.refresh);
    expect((await refresh(flow, a.refresh)).body.error).toBe("invalid_grant");
    expect(alive(flow)).toBe(false);
    expect(await mcpPing(flow, c.access)).toBe(401);
  });

  it("the graced response is sealed like the first: no plaintext token is stored", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    await next(flow, b.refresh);
    const dump = JSON.stringify(rows(flow, "SELECT * FROM refresh_tokens"));
    expect(dump).not.toContain(b.access);
    expect(dump).not.toContain(b.refresh);
  });
});

describe("a refresh with no scope", () => {
  it("returns the originally granted scope, also after a narrowed refresh", async () => {
    const flow = await makeFlow();
    const a = await issue(flow, { scope: "read:notes write:notes" });
    const narrowed = await refresh(flow, a.refresh, { scope: "read:notes" });
    expect(narrowed.body.scope).toBe("read:notes");
    const bare = await refresh(flow, narrowed.body.refresh_token as string);
    expect(bare.res.status).toBe(200);
    expect(bare.body.scope).toBe("read:notes write:notes");
    expect(decodeJwt(bare.body.access_token as string).scope).toBe("read:notes write:notes");
  });
});
