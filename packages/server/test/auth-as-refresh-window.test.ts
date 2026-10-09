// The one-step window of a refresh token is IDEMPOTENT (design v2 section 4.6, "As built (S6)"), and a
// refresh token belongs to the server secret that minted it. Review findings on slice S6:
//  * one parent token must not mint unbounded access tokens: every retry returns the first response;
//  * replacing the server secret retires every family, the current leaf included.
import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { secretGeneration } from "../src/auth/as-refresh-replay";
import {
  cleanupFlows,
  exchange,
  type Flow,
  issue,
  makeFlow,
  mcpPing,
  refreshFields,
  rows,
} from "./as-flow-harness";
import { SECRET } from "./as-operator-harness";

afterEach(cleanupFlows);

const WIDE = { scope: "read:notes write:notes" };
const OTHER_SECRET = "a-replaced-server-secret-0123456789abcdef";
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

const refresh = (flow: Flow, rt: string, over: Record<string, string | undefined> = {}) =>
  exchange(flow, refreshFields(rt, over));

async function next(flow: Flow, rt: string, over: Record<string, string | undefined> = {}) {
  const { res, body } = await refresh(flow, rt, over);
  expect(res.status, JSON.stringify(body)).toBe(200);
  return { access: body.access_token as string, refresh: body.refresh_token as string, body };
}

const count = (flow: Flow, sql: string): number =>
  rows<{ n: number }>(flow, `SELECT COUNT(*) AS n FROM ${sql}`)[0]?.n ?? -1;
const issuedCount = (flow: Flow): number => count(flow, "issued_access");
const liveFamilyRows = (flow: Flow): number =>
  count(flow, "refresh_tokens WHERE revoked_at IS NULL");
const sealOf = (flow: Flow, rt: string): string | null | undefined =>
  rows<{ replay: string | null }>(
    flow,
    "SELECT replay FROM refresh_tokens WHERE token_hash = ?",
    sha(rt),
  )[0]?.replay;

describe("idempotent window: the retry of a parent is answered with the first response", () => {
  it("N retries of RT0 give the identical access token (same jti) and successor, and ONE issued_access row", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const first = await next(flow, a.refresh);
    const before = issuedCount(flow); // the code exchange's token and this refresh's
    expect(before).toBe(2);
    for (let i = 0; i < 6; i++) {
      const retry = await next(flow, a.refresh);
      expect(retry.access).toBe(first.access);
      expect(retry.refresh).toBe(first.refresh);
      expect(decodeJwt(retry.access).jti).toBe(decodeJwt(first.access).jti);
      expect(retry.body.scope).toBe(first.body.scope);
    }
    expect(issuedCount(flow)).toBe(before);
    expect(count(flow, "refresh_tokens")).toBe(2);
    expect(await mcpPing(flow, first.access)).toBe(200);
  });

  it("expires_in on a retry is what is left of the token, never more than the first said", async () => {
    const flow = await makeFlow({ as: { accessTokenSeconds: 600 } });
    const a = await issue(flow);
    const first = await next(flow, a.refresh);
    flow.clock.t += 240_000;
    const retry = await next(flow, a.refresh);
    expect(first.body.expires_in).toBe(600);
    expect(retry.body.expires_in).toBeLessThanOrEqual(360);
    expect(retry.body.expires_in).toBeGreaterThan(300);
  });

  it("the retried token dies with the family when RT0 is replayed after RT1 was used", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    const retry = await next(flow, a.refresh);
    const c = await next(flow, b.refresh);
    flow.clock.t += 31_000; // past the default reuse grace
    expect((await refresh(flow, a.refresh)).body.error).toBe("invalid_grant");
    for (const t of [a.access, retry.access, c.access]) expect(await mcpPing(flow, t)).toBe(401);
    expect(liveFamilyRows(flow)).toBe(0);
  });

  it("the response is kept sealed: no plaintext access token in oauth.db, and none once the window closes", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    const dump = JSON.stringify(
      rows<{ name: string }>(flow, "SELECT name FROM sqlite_master WHERE type = 'table'").map((t) =>
        rows(flow, `SELECT * FROM "${t.name}"`),
      ),
    );
    expect(typeof sealOf(flow, b.refresh)).toBe("string");
    expect(dump).not.toContain(b.access);
    expect(dump).not.toContain(b.access.split(".")[2] as string);
    // Using the successor leaves b's copy for the reuse grace of a; using b's own successor ends it.
    const c = await next(flow, b.refresh);
    expect(typeof sealOf(flow, b.refresh)).toBe("string");
    await next(flow, c.refresh);
    expect(sealOf(flow, b.refresh)).toBeNull();
    // With no grace, using the successor closes the window at once.
    const strict = await makeFlow({ as: { refreshReuseGraceSeconds: 0 } });
    const s0 = await issue(strict);
    const s1 = await next(strict, s0.refresh);
    await next(strict, s1.refresh);
    expect(sealOf(strict, s1.refresh)).toBeNull();
  });

  it("a stored response that was tampered with, or lifted from another row, is refused and mints nothing", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    const sealed = sealOf(flow, b.refresh) as string;
    const minted = issuedCount(flow);
    const put = (value: string | null, rt: string) =>
      flow.db
        .prepare("UPDATE refresh_tokens SET replay = ? WHERE token_hash = ?")
        .run(value, sha(rt));

    const bytes = Buffer.from(sealed, "base64url");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    put(bytes.toString("base64url"), b.refresh);
    expect((await refresh(flow, a.refresh)).body.error).toBe("invalid_grant");

    put(null, b.refresh);
    expect((await refresh(flow, a.refresh)).body.error).toBe("invalid_grant");

    // A genuine seal of ANOTHER parent's response does not open under this parent.
    const a2 = await issue(flow);
    const b2 = await next(flow, a2.refresh);
    put(sealOf(flow, b2.refresh) as string, b.refresh);
    const beforeRestore = issuedCount(flow);
    expect((await refresh(flow, a.refresh)).body.error).toBe("invalid_grant");

    put(sealed, b.refresh);
    expect((await refresh(flow, a.refresh)).res.status).toBe(200);
    expect(issuedCount(flow)).toBe(beforeRestore);
    expect(beforeRestore).toBeGreaterThan(minted); // only the second family's own tokens were added
  });

  it("an expired stored access token is not replayed and nothing new is minted: invalid_grant, the family intact", async () => {
    const flow = await makeFlow({ as: { accessTokenSeconds: 300 } });
    const a = await issue(flow);
    await next(flow, a.refresh);
    const minted = issuedCount(flow);
    flow.clock.t += 301_000;
    const late = await refresh(flow, a.refresh);
    expect(late.res.status).toBe(400);
    expect(late.body.error).toBe("invalid_grant");
    expect(issuedCount(flow)).toBe(minted);
    expect(liveFamilyRows(flow)).toBe(2);
  });

  it("a stored access token that was revoked is not handed out again", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    flow.registry.revoke(decodeJwt(b.access).jti as string, "operator");
    expect((await refresh(flow, a.refresh)).body.error).toBe("invalid_grant");
  });

  it("a retry that asks for a different scope than the first response carried is refused; the same scope is replayed", async () => {
    const flow = await makeFlow();
    const a = await issue(flow, WIDE);
    const narrow = await next(flow, a.refresh, { scope: "read:notes" });
    const again = await next(flow, a.refresh, { scope: "read:notes" });
    expect(again.access).toBe(narrow.access);
    expect(again.body.scope).toBe("read:notes");
    const minted = issuedCount(flow);
    expect((await refresh(flow, a.refresh)).body.error).toBe("invalid_grant"); // asks for the full scope
    expect(issuedCount(flow)).toBe(minted);
  });

  it("simultaneous first refreshes end with one access token, one successor and no second live bearer", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const results = await Promise.all(Array.from({ length: 5 }, () => refresh(flow, a.refresh)));
    const ok = results.filter((r) => r.res.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.body.access_token)).size).toBe(1);
    expect(new Set(ok.map((r) => r.body.refresh_token)).size).toBe(1);
    // A loser that signed its own token before it lost revoked it: the code exchange's token and
    // the one winner are the only live ones.
    const live = rows<{ jti: string }>(flow, "SELECT jti FROM issued_access").filter(
      (r) => !flow.registry.isRevoked(r.jti),
    );
    expect(live).toHaveLength(2);
    expect(await mcpPing(flow, ok[0]?.body.access_token as string)).toBe(200);
  });
});

describe("secret replacement retires every family", () => {
  it("the current leaf presented after the secret was replaced: invalid_grant, family revoked, access tokens dead at /mcp", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    expect(await mcpPing(flow, b.access)).toBe(200);
    const restarted = flow.restartWith(OTHER_SECRET);
    const res = await refresh(restarted, b.refresh);
    expect(res.res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
    expect(liveFamilyRows(flow)).toBe(0);
    for (const t of [a.access, b.access]) {
      expect(await mcpPing(restarted, t)).toBe(401);
      expect(await mcpPing(flow, t)).toBe(401);
    }
    // Nothing started a chain under the new secret.
    expect(count(flow, "refresh_tokens")).toBe(2);
    expect((await refresh(restarted, b.refresh)).body.error).toBe("invalid_grant");
  });

  it("a parent inside its window (a retry) is refused after the replacement too, and nothing is minted", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    const minted = issuedCount(flow);
    const restarted = flow.restartWith(OTHER_SECRET);
    expect((await refresh(restarted, a.refresh)).body.error).toBe("invalid_grant");
    expect(issuedCount(flow)).toBe(minted);
    expect(await mcpPing(restarted, b.access)).toBe(401);
    expect(liveFamilyRows(flow)).toBe(0);
  });

  it("a restart with the SAME secret keeps every family working", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    const restarted = flow.restartWith(SECRET);
    const retry = await next(restarted, a.refresh); // the sealed response opens under the same secret
    expect(retry.access).toBe(b.access);
    expect((await refresh(restarted, b.refresh)).res.status).toBe(200);
  });

  it("every row carries the fingerprint of the secret that minted it, and it is not the secret", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    await next(flow, a.refresh);
    const gens = rows<{ secret_gen: string | null }>(flow, "SELECT secret_gen FROM refresh_tokens");
    expect(gens).toHaveLength(2);
    for (const g of gens) expect(g.secret_gen).toBe(secretGeneration(SECRET));
    expect(secretGeneration(SECRET)).toMatch(/^[0-9a-f]{16,}$/);
    expect(secretGeneration(SECRET)).not.toBe(secretGeneration(OTHER_SECRET));
    expect(JSON.stringify(rows(flow, "SELECT * FROM refresh_tokens"))).not.toContain(SECRET);
  });

  it("a row from before the fingerprint existed (NULL) is refused and its family revoked: one re-login after the upgrade", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    flow.db.prepare("UPDATE refresh_tokens SET secret_gen = NULL").run();
    expect((await refresh(flow, a.refresh)).body.error).toBe("invalid_grant");
    expect(liveFamilyRows(flow)).toBe(0);
    expect(await mcpPing(flow, a.access)).toBe(401);
  });

  it("another client presenting the token after the replacement revokes nothing", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const restarted = flow.restartWith(OTHER_SECRET);
    const thief = await refresh(restarted, a.refresh, { client_id: "native-client" });
    expect(thief.body.error).toBe("invalid_grant");
    expect(liveFamilyRows(flow)).toBe(1);
    expect(await mcpPing(flow, a.access)).toBe(200);
  });
});
