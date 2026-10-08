// A revocation is DURABLE: the oauth.db side (family or grant marked revoked) and the debt it owes the
// registry (one outbox row per access-token jti) commit in ONE transaction, and the debt is paid into
// auth.db idempotently after the commit, again at startup and maintenance, and before a refresh
// decides anything. Review finding on slice S6: a registry write that failed after the oauth.db
// commit left live access tokens behind a revoked family, and every later attempt saw `dead`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainRevocations, revokeFamily, revokeGrant } from "../src/auth/as-grants";
import {
  cleanupFlows,
  exchange,
  type Flow,
  issue,
  makeFlow,
  mcpPing,
  refreshFields,
  revokeCall,
  rows,
} from "./as-flow-harness";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupFlows();
});

const outbox = (flow: Flow): Array<{ jti: string; reason: string }> =>
  rows(flow, "SELECT jti, reason FROM revocation_outbox ORDER BY jti");

/** A family of three live access tokens: the code exchange's and two refreshes'. */
async function threeTokens(flow: Flow) {
  const a = await issue(flow);
  const b = await exchange(flow, refreshFields(a.refresh));
  const c = await exchange(flow, refreshFields(b.body.refresh_token as string));
  expect(c.res.status).toBe(200);
  const tokens = [a.access, b.body.access_token as string, c.body.access_token as string];
  for (const t of tokens) expect(await mcpPing(flow, t)).toBe(200);
  return { tokens, refresh: c.body.refresh_token as string, first: a.refresh };
}

const familyOf = (flow: Flow): string =>
  rows<{ family_id: string }>(flow, "SELECT DISTINCT family_id FROM refresh_tokens")[0]
    ?.family_id as string;

/** The registry fails on its `failOn`-th call (1-based) and works otherwise. */
function failingRegistry(flow: Flow, failOn: number[]) {
  const real = flow.registry.revoke.bind(flow.registry);
  let calls = 0;
  const spy = vi.spyOn(flow.registry, "revoke").mockImplementation((jti, reason) => {
    calls += 1;
    if (failOn.includes(calls)) throw new Error("auth.db is busy");
    return real(jti, reason);
  });
  return { spy, calls: () => calls };
}

describe("revocation outbox: a family", () => {
  it("registry.revoke throws on the FIRST call: the debt stays on disk and one drain kills every jti", async () => {
    const flow = await makeFlow();
    const { tokens } = await threeTokens(flow);
    const f = failingRegistry(flow, [1]);
    expect(() =>
      revokeFamily(flow.db, flow.registry, familyOf(flow), "test", flow.clock.t),
    ).toThrow("auth.db is busy");
    // The oauth.db side committed, and so did the debt: nothing was lost by the failure.
    expect(rows(flow, "SELECT 1 FROM refresh_tokens WHERE revoked_at IS NULL")).toHaveLength(0);
    expect(outbox(flow).length).toBeGreaterThanOrEqual(1);
    expect(f.calls()).toBeGreaterThanOrEqual(1);

    drainRevocations(flow.db, flow.registry);
    expect(outbox(flow)).toHaveLength(0);
    for (const t of tokens) expect(await mcpPing(flow, t)).toBe(401);
  });

  it("registry.revoke throws on a MIDDLE call: the rest are still revoked in that pass, the failed one on the next", async () => {
    const flow = await makeFlow();
    const { tokens } = await threeTokens(flow);
    failingRegistry(flow, [2]);
    expect(() =>
      revokeFamily(flow.db, flow.registry, familyOf(flow), "test", flow.clock.t),
    ).toThrow("auth.db is busy");
    expect(outbox(flow)).toHaveLength(1); // exactly the jti whose write failed
    const dead = [];
    for (const t of tokens) dead.push(await mcpPing(flow, t));
    expect(dead.filter((s) => s === 401)).toHaveLength(2);

    drainRevocations(flow.db, flow.registry);
    expect(outbox(flow)).toHaveLength(0);
    for (const t of tokens) expect(await mcpPing(flow, t)).toBe(401);
  });

  it("repeating a revocation, and draining twice, breaks nothing and writes nothing twice", async () => {
    const flow = await makeFlow();
    const { tokens } = await threeTokens(flow);
    failingRegistry(flow, [1]);
    expect(() =>
      revokeFamily(flow.db, flow.registry, familyOf(flow), "test", flow.clock.t),
    ).toThrow();
    vi.restoreAllMocks();
    expect(revokeFamily(flow.db, flow.registry, familyOf(flow), "again", flow.clock.t)).toBe(3);
    drainRevocations(flow.db, flow.registry);
    drainRevocations(flow.db, flow.registry);
    expect(outbox(flow)).toHaveLength(0);
    for (const t of tokens) expect(await mcpPing(flow, t)).toBe(401);
  });

  it("the family update and its outbox rows are ONE transaction: without the outbox nothing is marked revoked", async () => {
    const flow = await makeFlow();
    const { tokens } = await threeTokens(flow);
    flow.db.exec("DROP TABLE revocation_outbox");
    expect(() =>
      revokeFamily(flow.db, flow.registry, familyOf(flow), "test", flow.clock.t),
    ).toThrow();
    expect(rows(flow, "SELECT 1 FROM refresh_tokens WHERE revoked_at IS NULL")).toHaveLength(3);
    for (const t of tokens) expect(await mcpPing(flow, t)).toBe(200);
  });

  it("a refresh on the dead family repairs the leftover revocation before it decides anything", async () => {
    const flow = await makeFlow();
    const { tokens, refresh } = await threeTokens(flow);
    failingRegistry(flow, [1]);
    expect(() =>
      revokeFamily(flow.db, flow.registry, familyOf(flow), "test", flow.clock.t),
    ).toThrow();
    vi.restoreAllMocks();
    expect(outbox(flow).length).toBeGreaterThan(0);
    const late = await exchange(flow, refreshFields(refresh));
    expect(late.body.error).toBe("invalid_grant");
    expect(outbox(flow)).toHaveLength(0);
    for (const t of tokens) expect(await mcpPing(flow, t)).toBe(401);
  });

  it("a refresh whose repair cannot reach the registry fails closed with server_error, minting nothing", async () => {
    const flow = await makeFlow();
    const { first } = await threeTokens(flow);
    flow.db
      .prepare("INSERT INTO revocation_outbox (jti, reason, created_at) VALUES ('owed', 'test', 1)")
      .run();
    failingRegistry(flow, [1]);
    const minted = rows(flow, "SELECT 1 FROM issued_access").length;
    const res = await exchange(flow, refreshFields(first));
    expect(res.res.status).toBe(500);
    expect(res.body.error).toBe("server_error");
    expect(rows(flow, "SELECT 1 FROM issued_access")).toHaveLength(minted);
  });

  it("a client revoking the refresh token at /oauth/revoke fails closed and the debt is paid by the next drain", async () => {
    const flow = await makeFlow();
    const { tokens, first } = await threeTokens(flow);
    failingRegistry(flow, [2]);
    const res = await revokeCall(flow, { token: first, client_id: "test-client" });
    // The revocation endpoint cannot say 200 when the registry could not record it.
    expect(res.res.status).toBe(500);
    vi.restoreAllMocks();
    drainRevocations(flow.db, flow.registry);
    for (const t of tokens) expect(await mcpPing(flow, t)).toBe(401);
  });
});

describe("revocation outbox: a grant", () => {
  it("a registry failure partway through revoking a grant leaves the debt; a drain, or repeating the command, finishes it", async () => {
    const flow = await makeFlow();
    const one = await threeTokens(flow);
    const two = await issue(flow); // a second family of the same grant
    const grantId = rows<{ id: string }>(flow, "SELECT id FROM grants")[0]?.id as string;
    const all = [...one.tokens, two.access];
    failingRegistry(flow, [1, 3]);
    expect(() => revokeGrant(flow.db, flow.registry, grantId, "operator", flow.clock.t)).toThrow(
      "auth.db is busy",
    );
    // The grant and every family were marked in the same transaction as the debt.
    expect(rows(flow, "SELECT 1 FROM grants WHERE revoked_at IS NULL")).toHaveLength(0);
    expect(rows(flow, "SELECT 1 FROM refresh_tokens WHERE revoked_at IS NULL")).toHaveLength(0);
    expect(outbox(flow).length).toBeGreaterThanOrEqual(1);

    vi.restoreAllMocks();
    const again = revokeGrant(flow.db, flow.registry, grantId, "operator", flow.clock.t);
    expect(again.status).toBe("already_revoked");
    expect(again.accessTokens).toBe(4);
    expect(outbox(flow)).toHaveLength(0);
    for (const t of all) expect(await mcpPing(flow, t)).toBe(401);
  });

  it("the grant row and the outbox are ONE transaction: without the outbox the grant is not revoked", async () => {
    const flow = await makeFlow();
    const { tokens } = await threeTokens(flow);
    const grantId = rows<{ id: string }>(flow, "SELECT id FROM grants")[0]?.id as string;
    flow.db.exec("DROP TABLE revocation_outbox");
    expect(() => revokeGrant(flow.db, flow.registry, grantId, "operator", flow.clock.t)).toThrow();
    expect(rows(flow, "SELECT 1 FROM grants WHERE revoked_at IS NOT NULL")).toHaveLength(0);
    for (const t of tokens) expect(await mcpPing(flow, t)).toBe(200);
  });
});

describe("revocation outbox: startup and maintenance", () => {
  it("drainRevocations returns how many it paid, keeps what it could not, and is a no-op when empty", async () => {
    const flow = await makeFlow();
    const { tokens } = await threeTokens(flow);
    expect(drainRevocations(flow.db, flow.registry)).toBe(0);
    failingRegistry(flow, [1]);
    expect(() =>
      revokeFamily(flow.db, flow.registry, familyOf(flow), "test", flow.clock.t),
    ).toThrow();
    const owed = outbox(flow).length;
    expect(owed).toBeGreaterThan(0);
    failingRegistry(flow, [1]);
    expect(() => drainRevocations(flow.db, flow.registry)).toThrow("auth.db is busy");
    expect(outbox(flow).length).toBeGreaterThan(0);
    vi.restoreAllMocks();
    expect(drainRevocations(flow.db, flow.registry)).toBeGreaterThan(0);
    expect(outbox(flow)).toHaveLength(0);
    for (const t of tokens) expect(await mcpPing(flow, t)).toBe(401);
  });
});
