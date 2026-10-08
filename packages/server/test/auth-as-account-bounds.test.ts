// The account's `scopes_allowed` / `vaults_allowed` are an upper bound on every grant (design v2 section
// 4.5), re-read at each decision: a remembered consent and a code in flight must not outlive a
// narrowing of the account.
import { decodeJwt } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { accountBounds, applyBounds } from "../src/auth/as-account";
import {
  authorize,
  cleanupFlows,
  codeOf,
  consentPage,
  consentPost,
  exchange,
  handleOf,
  Jar,
  loginFor,
  makeFlow,
  mcpVaults,
  obtainCode,
  pkce,
  rows,
  tokenFields,
} from "./as-flow-harness";

afterEach(cleanupFlows);

type Flow = Awaited<ReturnType<typeof makeFlow>>;
const PERSONAS = {
  reader: { vaults: ["v1"], scopes: ["read:notes"] },
  author: { vaults: ["v1", "v2"], scopes: ["read:notes", "write:notes"] },
};
const WIDE = { scope: "read:notes write:notes" };
const narrow = (flow: Flow, column: "scopes_allowed" | "vaults_allowed", value: string | null) =>
  flow.db.prepare(`UPDATE users SET ${column} = ?`).run(value);

/** Approve a first grant the normal way, then return a fresh session's view of the next request. */
async function remember(flow: Flow, consent: Record<string, string> = {}) {
  const { challenge } = pkce();
  const { code } = await obtainCode(flow, new Jar(), challenge, WIDE, consent);
  expect(code).not.toBe("");
  expect(rows(flow, "SELECT 1 FROM grants")).toHaveLength(1);
}

/** Re-authorize with an already signed-in browser; returns where consent leads. */
async function again(flow: Flow, over: Record<string, string> = WIDE) {
  const jar = new Jar();
  const { challenge, verifier } = pkce();
  const a = await authorize(flow, jar, challenge, over);
  const next = a.headers.get("location") ?? "";
  const handle = handleOf(next);
  await loginFor(flow, jar, next);
  const page = await consentPage(flow, jar, handle);
  return { jar, handle, page, verifier, challenge };
}

describe("remembered consent re-derives the account's bounds", () => {
  it("control: an unchanged account still skips the page for a remembered grant", async () => {
    const flow = await makeFlow();
    await remember(flow);
    const { page } = await again(flow);
    expect(page.seen.res.status).toBe(303);
    expect(codeOf(page.seen.res.headers.get("location"))).not.toBe("");
  });

  it("scopes_allowed narrowed after the grant: no code is issued without the user, and none carries the removed scope", async () => {
    const flow = await makeFlow();
    await remember(flow);
    narrow(flow, "scopes_allowed", "read:notes");
    const { jar, page, verifier } = await again(flow);
    // The page is shown (nothing was auto-issued) and only offers what the account can still grant.
    expect(page.seen.res.status).toBe(200);
    expect(page.seen.text).toContain("Read notes");
    expect(page.seen.text).not.toContain("Create and change notes");
    expect(rows(flow, "SELECT 1 FROM auth_codes")).toHaveLength(1);

    const done = await consentPost(flow, jar, {
      csrf: page.csrf,
      request: page.request,
      decision: "approve",
    });
    const code = codeOf(done.res.headers.get("location"));
    const { body } = await exchange(flow, tokenFields(code, verifier));
    expect(body.scope).toBe("read:notes");
    expect(decodeJwt(body.access_token as string).scope).toBe("read:notes");
    // The code approved after the narrowing (the second row) never carried the removed scope.
    const [, latest] = rows<{ request_scope: string }>(
      flow,
      "SELECT request_scope FROM auth_codes ORDER BY rowid",
    );
    expect(latest?.request_scope).toBe("read:notes");
  });

  it("a request wholly within the narrowed bounds still rides the remembered grant", async () => {
    const flow = await makeFlow();
    await remember(flow);
    narrow(flow, "scopes_allowed", "read:notes");
    const { page } = await again(flow, { scope: "read:notes" });
    expect(page.seen.res.status).toBe(303);
    expect(codeOf(page.seen.res.headers.get("location"))).not.toBe("");
  });

  it("scopes_allowed narrowed to nothing the request wants: access_denied, never a code", async () => {
    const flow = await makeFlow();
    await remember(flow);
    narrow(flow, "scopes_allowed", "admin:*");
    const { jar, page } = await again(flow);
    expect(page.seen.res.status).toBe(200);
    const done = await consentPost(flow, jar, {
      csrf: page.csrf,
      request: page.request,
      decision: "approve",
    });
    expect(new URL(done.res.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "access_denied",
    );
    expect(rows(flow, "SELECT 1 FROM auth_codes")).toHaveLength(1);
  });

  it("vaults_allowed narrowed after a grant bound to that vault: consent is asked again and the vault cannot be re-chosen", async () => {
    const flow = await makeFlow({ personas: PERSONAS });
    await remember(flow, { persona: "author", vault: "v2" });
    narrow(flow, "vaults_allowed", "v1");
    const { jar, page } = await again(flow);
    expect(page.seen.res.status).toBe(200);
    expect(rows(flow, "SELECT 1 FROM auth_codes")).toHaveLength(1);

    const refused = await consentPost(flow, jar, {
      csrf: page.csrf,
      request: page.request,
      decision: "approve",
      persona: "author",
      vault: "v2",
    });
    expect(refused.res.status).toBe(400);
    expect(rows(flow, "SELECT 1 FROM auth_codes")).toHaveLength(1);

    const ok = await consentPost(flow, jar, {
      csrf: page.csrf,
      request: page.request,
      decision: "approve",
      persona: "author",
      vault: "v1",
    });
    expect(codeOf(ok.res.headers.get("location"))).not.toBe("");
    const vaults = rows<{ vault: string }>(
      flow,
      "SELECT vault FROM grants ORDER BY created_at, rowid",
    );
    expect(vaults.at(-1)?.vault).toBe("v1");
  });
});

describe("the token exchange re-derives the account's bounds", () => {
  async function codeFor(flow: Flow, over: Record<string, string | undefined>, consent = {}) {
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge, over, consent);
    expect(code).not.toBe("");
    return { code, verifier };
  }

  it("scopes_allowed narrowed between consent and exchange: the token drops the removed scope", async () => {
    const flow = await makeFlow();
    const { code, verifier } = await codeFor(flow, WIDE);
    narrow(flow, "scopes_allowed", "read:notes");
    const { res, body } = await exchange(flow, tokenFields(code, verifier));
    expect(res.status).toBe(200);
    expect(body.scope).toBe("read:notes");
    expect(decodeJwt(body.access_token as string).scope).toBe("read:notes");
    expect(rows<{ scope: string }>(flow, "SELECT scope FROM grants")[0]?.scope).toBe(
      "read:notes write:notes",
    );
  });

  it("scopes_allowed narrowed to nothing the code carries: invalid_grant, no token, nothing recorded", async () => {
    const flow = await makeFlow();
    const { code, verifier } = await codeFor(flow, WIDE);
    narrow(flow, "scopes_allowed", "admin:*");
    const { res, body } = await exchange(flow, tokenFields(code, verifier));
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_grant");
    expect(body).not.toHaveProperty("access_token");
    expect(rows(flow, "SELECT 1 FROM issued_access")).toHaveLength(0);
  });

  it("vaults_allowed narrowed between consent and exchange: invalid_grant, no token", async () => {
    const flow = await makeFlow({ personas: PERSONAS });
    const { code, verifier } = await codeFor(flow, WIDE, { persona: "author", vault: "v2" });
    narrow(flow, "vaults_allowed", "v1");
    const { res, body } = await exchange(flow, tokenFields(code, verifier));
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_grant");
    expect(rows(flow, "SELECT 1 FROM issued_access")).toHaveLength(0);
  });

  it("a disabled account gets no token", async () => {
    const flow = await makeFlow();
    const { code, verifier } = await codeFor(flow, WIDE);
    flow.db.prepare("UPDATE users SET disabled_at = ?").run(flow.clock.t);
    const { res, body } = await exchange(flow, tokenFields(code, verifier));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(body).not.toHaveProperty("access_token");
    expect(rows(flow, "SELECT 1 FROM issued_access")).toHaveLength(0);
  });

  it("a refused exchange leaves the code usable once the bounds allow it again", async () => {
    const flow = await makeFlow();
    const { code, verifier } = await codeFor(flow, WIDE);
    narrow(flow, "scopes_allowed", "admin:*");
    expect((await exchange(flow, tokenFields(code, verifier))).res.status).toBe(400);
    narrow(flow, "scopes_allowed", null);
    expect((await exchange(flow, tokenFields(code, verifier))).res.status).toBe(200);
  });
});

describe("accountBounds / applyBounds", () => {
  it("reads space- and comma-separated lists, null as unbounded, and a disabled or unknown sub as no account", async () => {
    const flow = await makeFlow();
    const sub = rows<{ sub: string }>(flow, "SELECT sub FROM users")[0]?.sub ?? "";
    expect(accountBounds(flow.db, sub)).toEqual({});
    narrow(flow, "scopes_allowed", "read:notes, write:*");
    narrow(flow, "vaults_allowed", "v1 v2");
    expect(accountBounds(flow.db, sub)).toEqual({
      scopes: ["read:notes", "write:*"],
      vaults: ["v1", "v2"],
    });
    expect(accountBounds(flow.db, "nobody")).toBeUndefined();
    flow.db.prepare("UPDATE users SET disabled_at = 1").run();
    expect(accountBounds(flow.db, sub)).toBeUndefined();
  });

  it("only ever removes: wildcards bound by family, a vault outside refuses", () => {
    const b = { scopes: ["read:*"], vaults: ["v1"] };
    expect(applyBounds(b, { scopes: ["read:notes", "write:notes"], vault: "v1" })).toEqual({
      ok: true,
      scopes: ["read:notes"],
      vault: "v1",
    });
    expect(applyBounds(b, { scopes: ["read:notes"], vault: "v2" })).toEqual({
      ok: false,
      reason: "vault",
    });
    expect(applyBounds(b, { scopes: ["write:notes"], vault: null })).toEqual({
      ok: false,
      reason: "scopes",
    });
    expect(applyBounds({}, { scopes: ["write:notes"], vault: "v9" })).toEqual({
      ok: true,
      scopes: ["write:notes"],
      vault: "v9",
    });
    expect(applyBounds({}, { scopes: ["write:notes"], vault: null })).toEqual({
      ok: true,
      scopes: ["write:notes"],
      vault: null,
    });
  });

  it("a vault-bounded account with no vault chosen gets its one permitted vault, never none", () => {
    const want = { scopes: ["read:notes"], vault: null };
    // The Codex finding, verbatim: this used to return success with no vault at all.
    expect(applyBounds({ vaults: ["v1"] }, want)).toEqual({
      ok: true,
      scopes: ["read:notes"],
      vault: "v1",
    });
    expect(applyBounds({ vaults: ["v1", "v2"] }, want)).toEqual({ ok: false, reason: "vault" });
    expect(applyBounds({ vaults: [] }, want)).toEqual({ ok: false, reason: "vault" });
  });

  it("empty bounds are deny-all for their dimension; only a missing (NULL) bound is unbounded", async () => {
    const flow = await makeFlow();
    const sub = rows<{ sub: string }>(flow, "SELECT sub FROM users")[0]?.sub ?? "";
    for (const empty of ["", "   ", ",", " , "]) {
      narrow(flow, "scopes_allowed", empty);
      narrow(flow, "vaults_allowed", empty);
      expect(accountBounds(flow.db, sub), JSON.stringify(empty)).toEqual({
        scopes: [],
        vaults: [],
      });
    }
    expect(applyBounds({ scopes: [] }, { scopes: ["read:notes"], vault: null })).toEqual({
      ok: false,
      reason: "scopes",
    });
    expect(applyBounds({ vaults: [] }, { scopes: ["read:notes"], vault: "v1" })).toEqual({
      ok: false,
      reason: "vault",
    });
  });
});

describe("empty account bounds deny issuance end to end", () => {
  it("empty scopes_allowed: consent is access_denied and no code exists", async () => {
    const flow = await makeFlow();
    narrow(flow, "scopes_allowed", "");
    const { code, location } = await obtainCode(flow, new Jar(), pkce().challenge, WIDE);
    expect(code).toBe("");
    expect(new URL(location).searchParams.get("error")).toBe("access_denied");
    expect(rows(flow, "SELECT 1 FROM auth_codes")).toHaveLength(0);
  });

  it("empty vaults_allowed: no grant, no code", async () => {
    const flow = await makeFlow({ personas: PERSONAS });
    narrow(flow, "vaults_allowed", "");
    const { code } = await obtainCode(flow, new Jar(), pkce().challenge, WIDE, {
      persona: "reader",
    });
    expect(code).toBe("");
    expect(rows(flow, "SELECT 1 FROM grants")).toHaveLength(0);
  });

  it("empty vaults_allowed narrowed after a code was issued: the exchange gives no token", async () => {
    const flow = await makeFlow();
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge, WIDE);
    narrow(flow, "vaults_allowed", "");
    const { res, body } = await exchange(flow, tokenFields(code, verifier));
    expect(res.status).toBe(400);
    expect(body).not.toHaveProperty("access_token");
  });
});

describe("a vault-bounded account reaches only its vault, even with the server default elsewhere", () => {
  const TWO = { vaults: ["v1", "v2"], defaultVault: "v2" };
  const READ = { scope: "read:vault read:notes" };

  async function token(flow: Flow, over = READ, consent: Record<string, string> = {}) {
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge, over, consent);
    expect(code).not.toBe("");
    const { res, body } = await exchange(flow, tokenFields(code, verifier));
    return { res, body, access: (body.access_token as string | undefined) ?? "" };
  }

  it("control: an unbounded account's unbound token rides the server default vault", async () => {
    const flow = await makeFlow(TWO);
    const { access } = await token(flow);
    expect(decodeJwt(access).vault).toBeUndefined();
    expect(await mcpVaults(flow, access)).toEqual(["v2"]);
  });

  it("vaults_allowed=v1, no persona or vault chosen: the grant, the code and the token carry v1, and /mcp shows only v1", async () => {
    const flow = await makeFlow(TWO);
    narrow(flow, "vaults_allowed", "v1");
    const { res, access } = await token(flow);
    expect(res.status).toBe(200);
    expect(decodeJwt(access).vault).toBe("v1");
    expect(rows<{ vault: string | null }>(flow, "SELECT vault FROM grants")[0]?.vault).toBe("v1");
    expect(await mcpVaults(flow, access)).toEqual(["v1"]);
    expect(await mcpVaults(flow, access)).not.toContain("v2");
  });

  it("two permitted vaults and none chosen: nothing is issued (the operator must pick one)", async () => {
    const flow = await makeFlow(TWO);
    narrow(flow, "vaults_allowed", "v1 v2");
    const { code } = await obtainCode(flow, new Jar(), pkce().challenge, READ);
    expect(code).toBe("");
    expect(rows(flow, "SELECT 1 FROM auth_codes")).toHaveLength(0);
    expect(rows(flow, "SELECT 1 FROM grants")).toHaveLength(0);
  });

  it("a remembered unbound grant, then the account is limited to v1: the next token is bound to v1", async () => {
    const flow = await makeFlow(TWO);
    await token(flow);
    narrow(flow, "vaults_allowed", "v1");
    const second = await token(flow);
    expect(decodeJwt(second.access).vault).toBe("v1");
    expect(await mcpVaults(flow, second.access)).toEqual(["v1"]);
  });

  it("a remembered unbound grant, then the account is limited to two vaults: asked again, not silently reused", async () => {
    const flow = await makeFlow(TWO);
    await token(flow);
    narrow(flow, "vaults_allowed", "v1 v2");
    const { code } = await obtainCode(flow, new Jar(), pkce().challenge, READ);
    expect(code).toBe("");
    expect(rows(flow, "SELECT 1 FROM auth_codes")).toHaveLength(1);
  });

  it("a code issued unbound, then the account is limited to v1 before the exchange: the token is bound to v1", async () => {
    const flow = await makeFlow(TWO);
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge, READ);
    narrow(flow, "vaults_allowed", "v1");
    const { res, body } = await exchange(flow, tokenFields(code, verifier));
    expect(res.status).toBe(200);
    const access = body.access_token as string;
    expect(decodeJwt(access).vault).toBe("v1");
    expect(await mcpVaults(flow, access)).toEqual(["v1"]);
  });

  it("a code issued unbound, then the account is limited to two vaults: no token", async () => {
    const flow = await makeFlow(TWO);
    const { verifier, challenge } = pkce();
    const { code } = await obtainCode(flow, new Jar(), challenge, READ);
    narrow(flow, "vaults_allowed", "v1 v2");
    const { res, body } = await exchange(flow, tokenFields(code, verifier));
    expect(res.status).toBe(400);
    expect(body).not.toHaveProperty("access_token");
    expect(rows(flow, "SELECT 1 FROM issued_access")).toHaveLength(0);
  });
});
