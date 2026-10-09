// `GET/POST /oauth/consent` (slice S5; design v2 sections 4.3 and 8): consent phishing, CSRF on
// consent, mix-up on the consent redirects, credential re-POST (303), headers, personas.
import { afterEach, describe, expect, it } from "vitest";
import {
  authorize,
  CLIENT_ID,
  CLIENT_REDIRECT,
  cleanupFlows,
  codeOf,
  consentPage,
  consentPost,
  handleOf,
  ISSUER,
  Jar,
  LOOPBACK_CLIENT,
  loginFor,
  MIN,
  makeFlow,
  obtainCode,
  pkce,
  rows,
} from "./as-flow-harness";
import { get } from "./as-operator-harness";

afterEach(cleanupFlows);
const { challenge } = pkce();

/** Authorize, sign in, and stop on the consent page. */
async function toConsent(flow: Awaited<ReturnType<typeof makeFlow>>, jar: Jar, over = {}) {
  const a = await authorize(flow, jar, challenge, over);
  const next = a.headers.get("location") ?? "";
  const handle = handleOf(next);
  const l = await loginFor(flow, jar, next);
  expect(l.res.headers.get("location")).toBe(`/oauth/consent?request=${handle}`);
  const page = await consentPage(flow, jar, handle);
  return { handle, page };
}

const codes = (flow: Awaited<ReturnType<typeof makeFlow>>) =>
  rows(flow, "SELECT * FROM auth_codes");

describe("approval", () => {
  it("shows the full context, then redirects with code, state and iss; the code is stored hashed for 60 s", async () => {
    const flow = await makeFlow();
    const jar = new Jar();
    const { page } = await toConsent(flow, jar);
    expect(page.seen.res.status).toBe(200);
    expect(page.seen.text).toContain("Test Client");
    expect(page.seen.text).toContain(CLIENT_ID);
    expect(page.seen.text).toContain("app.example");
    expect(page.seen.text).toContain("Read notes");
    expect(page.seen.text).toContain("https://vault.example.com/mcp");
    expect(page.seen.text).not.toContain("returns to an address on the computer");

    const done = await consentPost(flow, jar, {
      csrf: page.csrf,
      request: page.request,
      decision: "approve",
    });
    expect(done.res.status).toBe(303);
    const loc = new URL(done.res.headers.get("location") ?? "");
    expect(loc.origin + loc.pathname).toBe(CLIENT_REDIRECT);
    expect(loc.searchParams.get("state")).toBe("st-123");
    expect(loc.searchParams.get("iss")).toBe(ISSUER);
    const code = loc.searchParams.get("code") ?? "";
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = codes(flow) as Array<{
      code_hash: string;
      expires_at: number;
      used_at: number | null;
    }>;
    expect(row?.code_hash).not.toBe(code);
    expect(row?.used_at).toBeNull();
    expect((row?.expires_at ?? 0) - flow.clock.t).toBeLessThanOrEqual(60_000);
    expect((row?.expires_at ?? 0) - flow.clock.t).toBeGreaterThan(59_000);
    // The request is spent: a second approval of the same handle issues nothing.
    const again = await consentPost(flow, jar, {
      csrf: page.csrf,
      request: page.request,
      decision: "approve",
    });
    expect(again.res.status).toBe(400);
    expect(codes(flow)).toHaveLength(1);
  });

  it("deny redirects with access_denied, iss and state, and issues no code", async () => {
    const flow = await makeFlow();
    const jar = new Jar();
    const { page } = await toConsent(flow, jar);
    const done = await consentPost(flow, jar, {
      csrf: page.csrf,
      request: page.request,
      decision: "deny",
    });
    expect(done.res.status).toBe(303);
    const loc = new URL(done.res.headers.get("location") ?? "");
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("iss")).toBe(ISSUER);
    expect(loc.searchParams.get("state")).toBe("st-123");
    expect(codes(flow)).toHaveLength(0);
    expect(rows(flow, "SELECT 1 FROM auth_requests")).toHaveLength(0);
  });

  it("warns loudly when every redirect of the client is on loopback", async () => {
    const flow = await makeFlow({
      as: { clients: [{ clientId: "lo", name: "Lo", redirectUris: ["http://127.0.0.1/cb"] }] },
    });
    const { page } = await toConsent(flow, new Jar(), {
      client_id: "lo",
      redirect_uri: "http://127.0.0.1:4444/cb",
    });
    expect(page.seen.text).toContain("returns to an address on the computer");
  });
});

describe("consent phishing: a first grant needs a fresh login", () => {
  it("a session older than 5 minutes is sent to log in again, and no code is issued", async () => {
    const flow = await makeFlow();
    const jar = new Jar();
    const { handle, page } = await toConsent(flow, jar);
    flow.clock.t += 6 * MIN;
    const stale = await get(flow, `/oauth/consent?request=${handle}`, jar);
    expect(stale.res.status).toBe(303);
    expect(stale.res.headers.get("location")).toBe(`/oauth/login?request=${handle}&reauth=1`);
    // A form left open past the window is refused the same way.
    const post = await consentPost(flow, jar, {
      csrf: page.csrf,
      request: page.request,
      decision: "approve",
    });
    expect(post.res.status).toBe(303);
    expect(post.res.headers.get("location")).toBe(`/oauth/login?request=${handle}&reauth=1`);
    expect(codes(flow)).toHaveLength(0);

    // Signing in again (the login form is shown despite the live session) refreshes the clock.
    const form = await get(flow, `/oauth/login?request=${handle}&reauth=1`, jar);
    expect(form.res.status).toBe(200);
    expect(form.text).toContain("Sign in again");
    const l = await loginFor(flow, jar, `/oauth/login?request=${handle}&reauth=1`);
    expect(l.res.headers.get("location")).toBe(`/oauth/consent?request=${handle}`);
    const fresh = await consentPage(flow, jar, handle);
    expect(fresh.seen.res.status).toBe(200);
  });

  it("5 minutes minus a second is still fresh", async () => {
    const flow = await makeFlow();
    const jar = new Jar();
    const { handle } = await toConsent(flow, jar);
    flow.clock.t += 5 * MIN - 1000;
    const page = await consentPage(flow, jar, handle);
    expect(page.seen.res.status).toBe(200);
  });

  it("an authorize with a live session goes to consent, and never auto-approves a first grant", async () => {
    const flow = await makeFlow();
    const jar = new Jar();
    await toConsent(flow, jar);
    const a = await authorize(flow, jar, challenge);
    expect(a.headers.get("location")).toMatch(/^\/oauth\/consent\?request=/);
    const page = await get(flow, a.headers.get("location") ?? "", jar);
    expect(page.res.status).toBe(200);
    expect(codes(flow)).toHaveLength(0);
  });

  it("a remembered grant skips the page for a scope within it, even on an old session", async () => {
    const flow = await makeFlow();
    const jar = new Jar();
    const first = await obtainCode(flow, jar, challenge);
    expect(first.code).not.toBe("");
    flow.clock.t += 20 * MIN;
    // The session idles out at 30 minutes; at 20 it is still live but no longer fresh.
    const a = await authorize(flow, jar, challenge);
    const loc = a.headers.get("location") ?? "";
    expect(loc).toMatch(/^\/oauth\/consent/);
    const via = await get(flow, loc, jar);
    expect(via.res.status).toBe(303);
    const back = new URL(via.res.headers.get("location") ?? "");
    expect(back.origin + back.pathname).toBe(CLIENT_REDIRECT);
    expect(codeOf(via.res.headers.get("location"))).not.toBe("");
    expect(back.searchParams.get("iss")).toBe(ISSUER);
    expect(rows(flow, "SELECT 1 FROM grants")).toHaveLength(1);
  });

  it("a wider scope on a remembered grant shows consent again (no fresh login needed), then extends the grant", async () => {
    const flow = await makeFlow();
    const jar = new Jar();
    await obtainCode(flow, jar, challenge);
    flow.clock.t += 20 * MIN;
    const a = await authorize(flow, jar, challenge, { scope: "read:notes write:notes" });
    const page = await get(flow, a.headers.get("location") ?? "", jar);
    expect(page.res.status).toBe(200);
    expect(page.text).toContain("Create and change notes");
    expect(codes(flow)).toHaveLength(1);
    const handle = handleOf(a.headers.get("location"));
    const done = await consentPost(flow, jar, {
      csrf: page.csrf,
      request: handle,
      decision: "approve",
    });
    expect(codeOf(done.res.headers.get("location"))).not.toBe("");
    const grants = rows<{ scope: string }>(flow, "SELECT scope FROM grants");
    expect(grants).toHaveLength(1);
    expect(grants[0]?.scope.split(" ").sort()).toEqual(["read:notes", "write:notes"]);
  });

  it("a remembered grant is per redirect: another client, or a revoked grant, asks again", async () => {
    const flow = await makeFlow();
    const jar = new Jar();
    await obtainCode(flow, jar, challenge);
    flow.db.prepare("UPDATE grants SET revoked_at = ?").run(flow.clock.t);
    const a = await authorize(flow, jar, challenge);
    const page = await get(flow, a.headers.get("location") ?? "", jar);
    expect(page.res.status).toBe(200);
  });

  it("a loopback client's grant is remembered across ports (the default)", async () => {
    const flow = await makeFlow();
    const jar = new Jar();
    const first = await obtainCode(flow, jar, challenge, {
      client_id: LOOPBACK_CLIENT,
      redirect_uri: "http://localhost:5001/cb",
    });
    expect(first.code).not.toBe("");
    const a = await authorize(flow, jar, challenge, {
      client_id: LOOPBACK_CLIENT,
      redirect_uri: "http://localhost:6002/cb",
    });
    const via = await get(flow, a.headers.get("location") ?? "", jar);
    expect(via.res.status).toBe(303);
    expect(via.res.headers.get("location")).toMatch(/^http:\/\/localhost:6002\/cb\?/);
    expect(rows(flow, "SELECT redirect_uri FROM grants")).toEqual([
      { redirect_uri: "http://localhost/cb" },
    ]);
  });
});

describe("auth.as.consent.loopback: prompt makes every loopback sign-in ask", () => {
  const prompting = () => makeFlow({ as: { consent: { loopback: "prompt" } } });
  const loopbackAt = (port: number) => ({
    client_id: LOOPBACK_CLIENT,
    redirect_uri: `http://localhost:${port}/cb`,
  });

  it("a grant approved on one port does not approve another port, nor the same port again", async () => {
    const flow = await prompting();
    const jar = new Jar();
    expect((await obtainCode(flow, jar, challenge, loopbackAt(5001))).code).not.toBe("");
    expect(codes(flow)).toHaveLength(1);
    for (const port of [6002, 5001]) {
      const a = await authorize(flow, jar, challenge, loopbackAt(port));
      const via = await get(flow, a.headers.get("location") ?? "", jar);
      expect(via.res.status, `port ${port}`).toBe(200);
      expect(via.res.headers.get("location")).toBeNull();
      expect(codes(flow), `port ${port}`).toHaveLength(1);
    }
  });

  it("approving the page it shows still issues a code", async () => {
    const flow = await prompting();
    const jar = new Jar();
    await obtainCode(flow, jar, challenge, loopbackAt(5001));
    const a = await authorize(flow, jar, challenge, loopbackAt(6002));
    const handle = handleOf(a.headers.get("location"));
    const page = await consentPage(flow, jar, handle);
    const done = await consentPost(flow, jar, {
      csrf: page.csrf,
      request: handle,
      decision: "approve",
    });
    expect(codeOf(done.res.headers.get("location"))).not.toBe("");
    expect(codes(flow)).toHaveLength(2);
  });

  it("a hosted (non-loopback) redirect is still remembered", async () => {
    const flow = await prompting();
    const jar = new Jar();
    await obtainCode(flow, jar, challenge);
    flow.clock.t += 20 * MIN;
    const a = await authorize(flow, jar, challenge);
    const via = await get(flow, a.headers.get("location") ?? "", jar);
    expect(via.res.status).toBe(303);
    expect(codeOf(via.res.headers.get("location"))).not.toBe("");
  });
});

describe("CSRF on consent: nothing is approved without the form's own token, Origin and session", () => {
  async function setup() {
    const flow = await makeFlow();
    const jar = new Jar();
    const { handle, page } = await toConsent(flow, jar);
    return { flow, jar, handle, page };
  }
  const approve = (request: string, csrf: string) => ({ request, csrf, decision: "approve" });

  it("no token -> 403 and no code", async () => {
    const { flow, jar, handle } = await setup();
    const res = await consentPost(flow, jar, { request: handle, decision: "approve" });
    expect(res.res.status).toBe(403);
    expect(codes(flow)).toHaveLength(0);
    expect(rows(flow, "SELECT 1 FROM auth_requests")).toHaveLength(1);
  });

  it("another request handle's token -> 403 and no code", async () => {
    const { flow, jar, handle } = await setup();
    // A second pending request in the same session has its own token.
    const a2 = await authorize(flow, jar, challenge, { state: "other" });
    const h2 = handleOf(a2.headers.get("location"));
    const other = await consentPage(flow, jar, h2);
    expect(other.csrf).not.toBe("");
    const res = await consentPost(flow, jar, approve(handle, other.csrf));
    expect(res.res.status).toBe(403);
    expect(codes(flow)).toHaveLength(0);
  });

  it("a token from another session -> 403 and no code", async () => {
    const { flow, handle, page } = await setup();
    const jar2 = new Jar();
    await loginFor(flow, jar2, `/oauth/login`);
    const res = await consentPost(flow, jar2, approve(handle, page.csrf));
    expect(res.res.status).toBe(403);
    expect(codes(flow)).toHaveLength(0);
  });

  it("Origin: https://evil.example -> 403 and no code; so does a missing Origin", async () => {
    const { flow, jar, handle, page } = await setup();
    const evil = await consentPost(flow, jar, approve(handle, page.csrf), {
      origin: "https://evil.example",
    });
    expect(evil.res.status).toBe(403);
    const none = await consentPost(flow, jar, approve(handle, page.csrf), { origin: null });
    expect(none.res.status).toBe(403);
    expect(codes(flow)).toHaveLength(0);
  });

  it("a non-form content type is refused, and so is a request with no session (sent to log in)", async () => {
    const { flow, jar, handle, page } = await setup();
    const json = await consentPost(flow, jar, approve(handle, page.csrf), {
      contentType: "application/json",
    });
    expect(json.res.status).toBe(415);
    const nobody = await consentPost(flow, new Jar(), approve(handle, page.csrf));
    expect(nobody.res.status).toBe(303);
    expect(nobody.res.headers.get("location")).toBe(`/oauth/login?request=${handle}`);
    expect(codes(flow)).toHaveLength(0);
  });
});

describe("credential re-POST and headers", () => {
  it("login and consent POSTs answer 303, never 307 or 308", async () => {
    const flow = await makeFlow();
    const jar = new Jar();
    const a = await authorize(flow, jar, challenge);
    const next = a.headers.get("location") ?? "";
    const l = await loginFor(flow, jar, next);
    expect(l.res.status).toBe(303);
    const page = await consentPage(flow, jar, handleOf(next));
    const done = await consentPost(flow, jar, {
      csrf: page.csrf,
      request: page.request,
      decision: "approve",
    });
    expect(done.res.status).toBe(303);
    const deny = await authorize(flow, jar, challenge, { scope: "read:notes write:notes" });
    const p2 = await consentPage(flow, jar, handleOf(deny.headers.get("location")));
    const denied = await consentPost(flow, jar, {
      csrf: p2.csrf,
      request: p2.request,
      decision: "deny",
    });
    expect(denied.res.status).toBe(303);
  });

  it("the consent page is frame-proof, no-referrer, uncacheable, and lets the browser follow the redirect to the client only", async () => {
    const flow = await makeFlow();
    const { page } = await toConsent(flow, new Jar());
    const h = page.seen.res.headers;
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(h.get("referrer-policy")).toBe("no-referrer");
    expect(h.get("cache-control")).toBe("no-store");
    const csp = h.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'self' https://app.example;");
    expect(csp).not.toMatch(/\*(?!;)/);
  });

  it("a loopback client's consent page allows the loopback redirect on any port", async () => {
    const flow = await makeFlow();
    const { page } = await toConsent(flow, new Jar(), {
      client_id: LOOPBACK_CLIENT,
      redirect_uri: "http://localhost:9999/cb",
    });
    expect(page.seen.res.headers.get("content-security-policy")).toContain(
      "form-action 'self' http://localhost:*;",
    );
  });

  it("an expired or unknown request is a local error page, never a redirect", async () => {
    const flow = await makeFlow();
    const jar = new Jar();
    const { handle } = await toConsent(flow, jar);
    flow.clock.t += 11 * MIN;
    const gone = await get(flow, `/oauth/consent?request=${handle}`, jar);
    expect(gone.res.status).toBe(400);
    expect(gone.res.headers.get("location")).toBeNull();
    const junk = await get(flow, "/oauth/consent?request=nope", jar);
    expect(junk.res.status).toBe(400);
  });
});

describe("personas and account bounds", () => {
  const PERSONAS = {
    reader: { vaults: ["v1"], scopes: ["read:notes"] },
    author: { vaults: ["v1", "v2"], scopes: ["read:notes", "write:notes"] },
  };

  it("offers the configured personas and records the chosen persona and vault on the grant", async () => {
    const flow = await makeFlow({ personas: PERSONAS });
    const jar = new Jar();
    const { page } = await toConsent(flow, jar);
    expect(page.seen.text).toContain('value="reader"');
    expect(page.seen.text).toContain('value="author"');
    const done = await consentPost(flow, jar, {
      csrf: page.csrf,
      request: page.request,
      decision: "approve",
      persona: "author",
      vault: "v2",
    });
    expect(codeOf(done.res.headers.get("location"))).not.toBe("");
    expect(rows(flow, "SELECT persona, vault FROM grants")).toEqual([
      { persona: "author", vault: "v2" },
    ]);
  });

  it("refuses a vault outside the persona, an unknown persona, and a vault without a persona", async () => {
    const flow = await makeFlow({ personas: PERSONAS });
    const jar = new Jar();
    const { page } = await toConsent(flow, jar);
    const attempts: Array<Record<string, string>> = [
      { persona: "reader", vault: "v2" },
      { persona: "ghost" },
      { vault: "v1" },
    ];
    for (const extra of attempts) {
      const res = await consentPost(flow, jar, {
        csrf: page.csrf,
        request: page.request,
        decision: "approve",
        ...extra,
      });
      expect(res.res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(codes(flow)).toHaveLength(0);
  });

  it("an account's scopes_allowed only removes scopes; nothing left is access_denied", async () => {
    const flow = await makeFlow();
    flow.db.prepare("UPDATE users SET scopes_allowed = 'read:notes'").run();
    const jar = new Jar();
    const { page } = await toConsent(flow, jar, { scope: "read:notes write:notes" });
    const done = await consentPost(flow, jar, {
      csrf: page.csrf,
      request: page.request,
      decision: "approve",
    });
    expect(codeOf(done.res.headers.get("location"))).not.toBe("");
    expect(rows<{ scope: string }>(flow, "SELECT scope FROM grants")[0]?.scope).toBe("read:notes");

    const jar2 = new Jar();
    const other = await toConsent(flow, jar2, { scope: "write:notes", state: "s2" });
    const denied = await consentPost(flow, jar2, {
      csrf: other.page.csrf,
      request: other.page.request,
      decision: "approve",
    });
    expect(new URL(denied.res.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "access_denied",
    );
  });
});
