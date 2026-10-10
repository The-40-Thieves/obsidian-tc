// `POST /oauth/token`, refresh_token grant (slice S6; design v2 sections 4.3, 4.6 and 8): a refresh token
// is issued on every code exchange, rotates on every use, and a reuse beyond the one-step window kills
// the family and every access token issued from it. Every failure is the same `invalid_grant`.
import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { revokeFamily, revokeGrant } from "../src/auth/as-grants";
import {
  CLIENT_ID,
  cleanupFlows,
  exchange,
  type Flow,
  issue,
  Jar,
  LOOPBACK_CLIENT,
  makeFlow,
  mcpPing,
  mcpVaults,
  obtainCode,
  pkce,
  RESOURCE,
  refreshFields,
  rows,
  SECRET_CLIENT,
  tokenFields,
} from "./as-flow-harness";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupFlows();
});

const DAY = 86_400_000;
/** Past the default `auth.as.refreshReuseGraceSeconds` (30), so a stale token is a reuse again. */
const PAST_GRACE = 31_000;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const WIDE = { scope: "read:notes write:notes" };
const PERSONAS = {
  reader: { vaults: ["v1"], scopes: ["read:notes"] },
  author: { vaults: ["v1", "v2"], scopes: ["read:notes", "write:notes"] },
};

const refresh = (
  flow: Flow,
  rt: string | undefined,
  over: Record<string, string | undefined> = {},
  headers: Record<string, string> = {},
) => exchange(flow, refreshFields(rt, over), headers);

/** A refresh that must succeed: the new access and refresh token. */
async function next(flow: Flow, rt: string) {
  const { res, body } = await refresh(flow, rt);
  expect(res.status, JSON.stringify(body)).toBe(200);
  return { access: body.access_token as string, refresh: body.refresh_token as string, body };
}

const familyRows = (flow: Flow) =>
  rows<{
    token_hash: string;
    parent_hash: string | null;
    family_id: string;
    scope: string;
    issued_at: number;
    family_expires_at: number;
    successor_first_used_at: number | null;
    revoked_at: number | null;
  }>(flow, "SELECT * FROM refresh_tokens ORDER BY issued_at, rowid");

describe("issuing on the code exchange", () => {
  it("returns a refresh token whether or not offline_access was asked, stored as SHA-256 only", async () => {
    const flow = await makeFlow();
    const first = await issue(flow);
    expect(first.refresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.body.scope).toBe("read:notes");
    const [row] = familyRows(flow);
    expect(row?.token_hash).toBe(sha(first.refresh));
    expect(row?.parent_hash).toBeNull();
    expect(row?.scope).toBe("read:notes");
    expect(row?.family_expires_at).toBe(
      row?.issued_at !== undefined ? row.issued_at + 30 * DAY : 0,
    );
    // The family id is the code's, so a replayed code revokes the refresh token too.
    const codeHash = rows<{ code_hash: string }>(flow, "SELECT code_hash FROM auth_codes")[0]
      ?.code_hash;
    expect(row?.family_id).toBe(codeHash);
  });

  it("asking for offline_access changes nothing and the claim never carries it", async () => {
    const flow = await makeFlow();
    const asked = await issue(flow, { scope: "read:notes offline_access" });
    expect(asked.refresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(decodeJwt(asked.access).scope).toBe("read:notes");
  });

  it("the family lives auth.as.refreshTokenDays from its start", async () => {
    const flow = await makeFlow({ as: { refreshTokenDays: 2 } });
    await issue(flow);
    const [row] = familyRows(flow);
    expect((row?.family_expires_at ?? 0) - (row?.issued_at ?? 0)).toBe(2 * DAY);
  });

  it("no table of oauth.db holds a plaintext refresh token (nor the next one)", async () => {
    const flow = await makeFlow();
    const first = await issue(flow);
    const second = await next(flow, first.refresh);
    const tables = rows<{ name: string }>(
      flow,
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).map((t) => t.name);
    const dump = JSON.stringify(tables.map((t) => rows(flow, `SELECT * FROM "${t}"`)));
    expect(dump).toContain(sha(first.refresh));
    expect(dump).toContain(sha(second.refresh));
    expect(dump).not.toContain(first.refresh);
    expect(dump).not.toContain(second.refresh);
  });

  it("a replayed authorization code kills the refresh token it issued", async () => {
    const flow = await makeFlow();
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge);
    const ok = await exchange(flow, tokenFields(code, verifier));
    const rt = ok.body.refresh_token as string;
    const replay = await exchange(flow, tokenFields(code, verifier));
    expect(replay.body.error).toBe("invalid_grant");
    expect((await refresh(flow, rt)).body.error).toBe("invalid_grant");
    expect(await mcpPing(flow, ok.body.access_token as string)).toBe(401);
  });
});

describe("rotation", () => {
  it("every use returns a new refresh token and a new access token that verifies at /mcp", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    const c = await next(flow, b.refresh);
    expect(new Set([a.refresh, b.refresh, c.refresh]).size).toBe(3);
    expect(new Set([a.access, b.access, c.access]).size).toBe(3);
    expect(b.body).toMatchObject({ token_type: "Bearer", expires_in: 1800, scope: "read:notes" });
    for (const t of [a.access, b.access, c.access]) expect(await mcpPing(flow, t)).toBe(200);
    const claims = decodeJwt(c.access);
    expect(claims).toMatchObject({ client_id: CLIENT_ID, aud: RESOURCE, scope: "read:notes" });
    const rowsNow = familyRows(flow);
    expect(rowsNow).toHaveLength(3);
    expect(rowsNow[1]?.parent_hash).toBe(sha(a.refresh));
    expect(rowsNow[2]?.parent_hash).toBe(sha(b.refresh));
    // One family: every access token's jti is recorded under it.
    const fams = rows<{ family_id: string }>(flow, "SELECT DISTINCT family_id FROM issued_access");
    expect(fams).toHaveLength(1);
    expect(rows(flow, "SELECT 1 FROM issued_access")).toHaveLength(3);
  });

  it("the response is no-store and the same refresh_token field", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const { res } = await refresh(flow, a.refresh);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
  });

  it("the absolute cap counts from the family's start and rotation never extends it", async () => {
    const flow = await makeFlow({ as: { refreshTokenDays: 1 } });
    const a = await issue(flow);
    const start = familyRows(flow)[0]?.family_expires_at ?? 0;
    flow.clock.t += DAY * 0.6;
    const b = await next(flow, a.refresh);
    flow.clock.t += DAY * 0.3;
    const c = await next(flow, b.refresh);
    expect(familyRows(flow).map((r) => r.family_expires_at)).toEqual([start, start, start]);
    flow.clock.t += DAY * 0.2;
    const late = await refresh(flow, c.refresh);
    expect(late.res.status).toBe(400);
    expect(late.body.error).toBe("invalid_grant");
  });

  it("a refresh may narrow the scope, and the family keeps the full scope", async () => {
    const flow = await makeFlow();
    const a = await issue(flow, WIDE);
    expect(a.body.scope).toBe("read:notes write:notes");
    const narrowed = await refresh(flow, a.refresh, { scope: "read:notes" });
    expect(narrowed.body.scope).toBe("read:notes");
    expect(decodeJwt(narrowed.body.access_token as string).scope).toBe("read:notes");
    const again = await refresh(flow, narrowed.body.refresh_token as string);
    expect(again.body.scope).toBe("read:notes write:notes");
  });

  it("a refresh never widens: more scope than the family holds is invalid_grant and burns nothing", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    for (const scope of ["read:notes write:notes", "admin:*", "write:notes"]) {
      const { res, body } = await refresh(flow, a.refresh, { scope });
      expect(res.status, scope).toBe(400);
      expect(body.error, scope).toBe("invalid_grant");
    }
    expect(familyRows(flow)).toHaveLength(1);
    expect((await refresh(flow, a.refresh)).res.status).toBe(200);
  });

  it("a resource other than this server's is invalid_target; naming it is fine", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const bad = await refresh(flow, a.refresh, { resource: "https://other.example/mcp" });
    expect(bad.body.error).toBe("invalid_target");
    expect((await refresh(flow, a.refresh, { resource: RESOURCE })).res.status).toBe(200);
  });

  it("a missing or repeated refresh_token is invalid_request, not an oracle", async () => {
    const flow = await makeFlow();
    expect((await refresh(flow, undefined)).body.error).toBe("invalid_request");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
    });
    body.append("refresh_token", "a");
    body.append("refresh_token", "b");
    const res = await flow.app.request(flow.url("/oauth/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_request" });
  });
});

describe("refresh-token theft: reuse beyond the window revokes the family [S6 row]", () => {
  it("use RT1->RT2, use RT2->RT3, replay RT1: invalid_grant, RT3 and the family's access tokens die", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    const c = await next(flow, b.refresh);
    expect(await mcpPing(flow, c.access)).toBe(200);

    flow.clock.t += PAST_GRACE;
    const replay = await refresh(flow, a.refresh);
    expect(replay.res.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");

    expect((await refresh(flow, c.refresh)).body.error).toBe("invalid_grant");
    expect((await refresh(flow, b.refresh)).body.error).toBe("invalid_grant");
    for (const t of [a.access, b.access, c.access]) expect(await mcpPing(flow, t)).toBe(401);
    expect(familyRows(flow).every((r) => r.revoked_at !== null)).toBe(true);
  });

  it("a token two steps behind is reuse too, however far back", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    const c = await next(flow, b.refresh);
    const d = await next(flow, c.refresh);
    await next(flow, d.refresh); // the family moved two used steps past b: a reuse inside the grace too
    expect((await refresh(flow, b.refresh)).body.error).toBe("invalid_grant");
    expect(await mcpPing(flow, d.access)).toBe(401);
    expect((await refresh(flow, d.refresh)).body.error).toBe("invalid_grant");
  });

  it("only that family dies: another family of the same grant and another grant keep working", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const other = await issue(flow); // remembered consent: same grant, a second family
    const b = await next(flow, a.refresh);
    await next(flow, b.refresh);
    flow.clock.t += PAST_GRACE;
    expect((await refresh(flow, a.refresh)).body.error).toBe("invalid_grant");
    expect(await mcpPing(flow, other.access)).toBe(200);
    expect((await refresh(flow, other.refresh)).res.status).toBe(200);
  });

  it("an already revoked family answers invalid_grant and does nothing more", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    await next(flow, b.refresh);
    flow.clock.t += PAST_GRACE;
    await refresh(flow, a.refresh);
    const rowsBefore = JSON.stringify(familyRows(flow));
    expect((await refresh(flow, a.refresh)).body.error).toBe("invalid_grant");
    expect(JSON.stringify(familyRows(flow))).toBe(rowsBefore);
  });
});

describe("the one-step window", () => {
  it("the previous token is accepted again until its successor is first used, and gets the SAME successor", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    const retry = await next(flow, a.refresh); // the response carrying `b` was lost
    expect(retry.refresh).toBe(b.refresh);
    // The whole response is idempotent: the retry is handed the access token the first request made.
    expect(retry.access).toBe(b.access);
    expect(familyRows(flow)).toHaveLength(2);
    for (const t of [a.access, b.access]) expect(await mcpPing(flow, t)).toBe(200);
    // ...and the family carries on from there.
    const c = await next(flow, retry.refresh);
    expect(c.refresh).not.toBe(b.refresh);
  });

  it("the window closes the moment the successor is used", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    const c = await next(flow, b.refresh);
    flow.clock.t += PAST_GRACE;
    const late = await refresh(flow, a.refresh);
    expect(late.body.error).toBe("invalid_grant");
    expect(await mcpPing(flow, c.access)).toBe(401);
    expect((await refresh(flow, c.refresh)).body.error).toBe("invalid_grant");
  });

  it("the previous token of an unused successor stays accepted: RT2 replayed while RT3 is unused", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    const c = await next(flow, b.refresh);
    const retry = await next(flow, b.refresh);
    expect(retry.refresh).toBe(c.refresh);
    expect(familyRows(flow)).toHaveLength(3);
  });
});

describe("two simultaneous refreshes of the same token", () => {
  it("never fork the family: one successor, the family intact, the loser is only a retry", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const results = await Promise.all([
      refresh(flow, a.refresh),
      refresh(flow, a.refresh),
      refresh(flow, a.refresh),
    ]);
    const ok = results.filter((r) => r.res.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      if (r.res.status !== 200) expect(r.body.error).toBe("invalid_grant");
    }
    // The design's window accepts the previous token until its successor is used, so every success
    // carries the one successor: no second live token ever exists.
    expect(new Set(ok.map((r) => r.body.refresh_token)).size).toBe(1);
    expect(new Set(ok.map((r) => r.body.access_token)).size).toBe(1);
    expect(familyRows(flow)).toHaveLength(2);
    expect(familyRows(flow).every((r) => r.revoked_at === null)).toBe(true);
    const successor = ok[0]?.body.refresh_token as string;
    for (const r of ok) expect(await mcpPing(flow, r.body.access_token as string)).toBe(200);
    expect((await refresh(flow, successor)).res.status).toBe(200);
  });

  it("a use of the successor racing a retry of the parent ends in exactly one of the two orders", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    const [viaChild, viaParent] = await Promise.all([
      refresh(flow, b.refresh),
      refresh(flow, a.refresh),
    ]);
    expect(viaChild.res.status).toBe(200);
    if (viaParent.res.status === 200) {
      // The parent got in first: it was a retry of the window, the family lives.
      expect(familyRows(flow).every((r) => r.revoked_at === null)).toBe(true);
    } else {
      // The child got in first: the parent is reuse, the family is gone.
      expect(viaParent.body.error).toBe("invalid_grant");
      expect(familyRows(flow).every((r) => r.revoked_at !== null)).toBe(true);
    }
  });

  it("a revocation never loses to an in-flight refresh: the access token it signed is revoked too", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    await next(flow, b.refresh);
    flow.clock.t += PAST_GRACE;
    const [theft, mine] = await Promise.all([
      refresh(flow, a.refresh),
      refresh(flow, b.refresh), // a retry racing the replay of a
    ]);
    expect(theft.body.error).toBe("invalid_grant");
    if (mine.res.status === 200)
      expect(await mcpPing(flow, mine.body.access_token as string)).toBe(401);
  });
});

describe("invalid_grant on every refresh failure, with one message", () => {
  it("unknown, malformed, empty, expired, revoked, wrong client and wider scope are indistinguishable", async () => {
    const flow = await makeFlow({ as: { refreshTokenDays: 1 } });
    const live = await issue(flow);
    flow.db.prepare("UPDATE grants SET revoked_at = ?").run(flow.clock.t);

    const attempts: Array<[string, Awaited<ReturnType<typeof refresh>>]> = [
      ["unknown", await refresh(flow, "A".repeat(43))],
      ["malformed", await refresh(flow, "not a token!")],
      ["very long", await refresh(flow, "x".repeat(5000))],
      ["live token, revoked grant", await refresh(flow, live.refresh)],
    ];
    flow.db.prepare("UPDATE grants SET revoked_at = NULL").run();
    attempts.push([
      "wrong client",
      await refresh(flow, live.refresh, { client_id: LOOPBACK_CLIENT }),
    ]);
    attempts.push(["wider scope", await refresh(flow, live.refresh, { scope: "write:notes" })]);
    flow.clock.t += 2 * DAY;
    attempts.push(["past the cap", await refresh(flow, live.refresh)]);
    const seen = new Set<string>();
    for (const [name, r] of attempts) {
      expect(r.res.status, name).toBe(400);
      expect(r.body.error, name).toBe("invalid_grant");
      seen.add(JSON.stringify(r.body));
    }
    expect(seen.size, "one error body for every failure").toBe(1);
  });

  it("a disabled account and an emptied bound are invalid_grant, and the refresh token is not burned", async () => {
    const flow = await makeFlow();
    const a = await issue(flow, WIDE);
    // A second enabled account keeps the server claimed, so the refusal is the account's own.
    flow.db
      .prepare(
        "INSERT INTO users (sub, username, password_hash, created_at) VALUES ('u2', 'second', 'x', ?)",
      )
      .run(flow.clock.t);
    flow.db.prepare("UPDATE users SET disabled_at = ? WHERE sub <> 'u2'").run(flow.clock.t);
    expect((await refresh(flow, a.refresh)).body.error).toBe("invalid_grant");
    flow.db.prepare("UPDATE users SET disabled_at = NULL").run();
    flow.db.prepare("UPDATE users SET scopes_allowed = '' WHERE sub <> 'u2'").run();
    expect((await refresh(flow, a.refresh)).body.error).toBe("invalid_grant");
    flow.db.prepare("UPDATE users SET scopes_allowed = NULL").run();
    expect(familyRows(flow)).toHaveLength(1);
    expect((await refresh(flow, a.refresh)).res.status).toBe(200);
  });

  it("a request for a confidential client without its secret is invalid_client before the token is looked at", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const { res, body } = await refresh(flow, a.refresh, { client_id: SECRET_CLIENT });
    expect(res.status).toBe(401);
    expect(body.error).toBe("invalid_client");
  });
});

describe("client binding", () => {
  it("another client presenting the token is invalid_grant and revokes nothing, the owner carries on", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    await next(flow, b.refresh);
    // `a` is two steps old: for its OWNER that is reuse, for anyone else it must not be.
    const thief = await refresh(flow, a.refresh, { client_id: LOOPBACK_CLIENT });
    expect(thief.body.error).toBe("invalid_grant");
    expect(familyRows(flow).every((r) => r.revoked_at === null)).toBe(true);
    expect(await mcpPing(flow, b.access)).toBe(200);
  });

  it("a client that presents a live token of another client does not rotate it", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    await refresh(flow, a.refresh, { client_id: LOOPBACK_CLIENT });
    expect(familyRows(flow)).toHaveLength(1);
    expect((await refresh(flow, a.refresh)).res.status).toBe(200);
  });
});

describe("the account's bounds are re-applied at refresh", () => {
  it("scopes_allowed narrowed since the last token: the new token is narrowed, the family lives", async () => {
    const flow = await makeFlow();
    const a = await issue(flow, WIDE);
    flow.db.prepare("UPDATE users SET scopes_allowed = 'read:notes'").run();
    const b = await refresh(flow, a.refresh);
    expect(b.res.status).toBe(200);
    expect(b.body.scope).toBe("read:notes");
    expect(decodeJwt(b.body.access_token as string).scope).toBe("read:notes");
    // Nothing is copied into the family: lifting the bound lifts the narrowing.
    flow.db.prepare("UPDATE users SET scopes_allowed = NULL").run();
    expect((await refresh(flow, b.body.refresh_token as string)).body.scope).toBe(
      "read:notes write:notes",
    );
  });

  it("narrowed to nothing the family holds: invalid_grant", async () => {
    const flow = await makeFlow();
    const a = await issue(flow, WIDE);
    flow.db.prepare("UPDATE users SET scopes_allowed = 'admin:*'").run();
    expect((await refresh(flow, a.refresh)).body.error).toBe("invalid_grant");
  });

  it("vaults_allowed narrowed away from the grant's vault: invalid_grant", async () => {
    const flow = await makeFlow({ personas: PERSONAS, vaults: ["v1", "v2"] });
    const a = await issue(flow, WIDE, { persona: "author", vault: "v2" });
    expect(decodeJwt(a.access).vault).toBe("v2");
    flow.db.prepare("UPDATE users SET vaults_allowed = 'v1'").run();
    expect((await refresh(flow, a.refresh)).body.error).toBe("invalid_grant");
  });

  it("a vault-bounded account is never refreshed into an unbound token: it gets its one vault", async () => {
    const flow = await makeFlow({ vaults: ["v1", "v2"], defaultVault: "v2" });
    const a = await issue(flow, { scope: "read:vault read:notes" });
    expect(decodeJwt(a.access).vault).toBeUndefined();
    flow.db.prepare("UPDATE users SET vaults_allowed = 'v1'").run();
    const b = await next(flow, a.refresh);
    expect(decodeJwt(b.access).vault).toBe("v1");
    expect(await mcpVaults(flow, b.access)).toEqual(["v1"]);
    // Several permitted vaults and none chosen: nothing may issue.
    flow.db.prepare("UPDATE users SET vaults_allowed = 'v1 v2'").run();
    expect((await refresh(flow, b.refresh)).body.error).toBe("invalid_grant");
  });

  it("empty vaults_allowed denies, and a persona's vault stays on the token", async () => {
    const flow = await makeFlow({ personas: PERSONAS, vaults: ["v1", "v2"] });
    const a = await issue(flow, WIDE, { persona: "author", vault: "v2" });
    const same = await next(flow, a.refresh);
    expect(decodeJwt(same.access)).toMatchObject({ persona: "author", vault: "v2" });
    flow.db.prepare("UPDATE users SET vaults_allowed = ''").run();
    expect((await refresh(flow, same.refresh)).body.error).toBe("invalid_grant");
  });
});

describe("what is recorded before a token may leave", () => {
  it("a failure recording the jti ends the refresh with no token and the refresh token still usable", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const spy = vi.spyOn(flow.registry, "recordToken").mockImplementation(() => {
      throw new Error("disk full");
    });
    const failed = await refresh(flow, a.refresh);
    expect(failed.res.status).toBe(500);
    expect(failed.body).not.toHaveProperty("access_token");
    expect(failed.body).not.toHaveProperty("refresh_token");
    expect(familyRows(flow)).toHaveLength(1);
    spy.mockRestore();
    expect((await refresh(flow, a.refresh)).res.status).toBe(200);
  });

  // The state changes AFTER the outer check passed, at the very moment the new access token is
  // recorded and before the rotation commits: only the re-check under the write lock can catch it.
  const LANDING: Array<[string, (flow: Flow, familyId: string) => void]> = [
    [
      "the family is revoked",
      (f, id) => revokeFamily(f.db, f.registry, id, "elsewhere", f.clock.t),
    ],
    [
      "the grant is revoked",
      (f) => revokeGrant(f.db, f.registry, grantIdOf(f), "operator", f.clock.t),
    ],
    [
      "the family reaches its cap",
      (f) => {
        f.clock.t += 31 * DAY;
      },
    ],
  ];
  const grantIdOf = (f: Flow): string =>
    rows<{ id: string }>(f, "SELECT id FROM grants")[0]?.id as string;

  for (const [name, land] of LANDING) {
    it(`${name} while a refresh is being signed: invalid_grant, nothing issued, the recorded jti revoked`, async () => {
      const flow = await makeFlow();
      const a = await issue(flow);
      const familyId = familyRows(flow)[0]?.family_id as string;
      const record = flow.registry.recordToken.bind(flow.registry);
      vi.spyOn(flow.registry, "recordToken").mockImplementation((t) => {
        record(t);
        land(flow, familyId);
      });
      const { res, body } = await refresh(flow, a.refresh);
      expect(res.status).toBe(400);
      expect(body.error).toBe("invalid_grant");
      expect(body).not.toHaveProperty("access_token");
      expect(body).not.toHaveProperty("refresh_token");
      const jtis = rows<{ jti: string }>(flow, "SELECT jti FROM issued_access");
      expect(jtis).toHaveLength(2);
      // The refused refresh revoked the jti it recorded (the first token's too, in the revocations).
      const fresh = jtis.find((j) => j.jti !== decodeJwt(a.access).jti);
      expect(flow.registry.isRevoked(fresh?.jti as string)).toBe(true);
      expect(familyRows(flow)).toHaveLength(1);
    });
  }

  it("the new access token's jti is in issued_access under the family before the refresh is answered", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    const b = await next(flow, a.refresh);
    const jti = decodeJwt(b.access).jti;
    const [row] = rows<{ family_id: string }>(
      flow,
      "SELECT family_id FROM issued_access WHERE jti = ?",
      jti,
    );
    expect(row?.family_id).toBe(familyRows(flow)[0]?.family_id);
  });
});

describe("revoking a grant", () => {
  it("a revoked grant refuses its refresh tokens", async () => {
    const flow = await makeFlow();
    const a = await issue(flow);
    flow.db.prepare("UPDATE grants SET revoked_at = ?").run(flow.clock.t);
    expect((await refresh(flow, a.refresh)).body.error).toBe("invalid_grant");
  });
});
