// Remembered consent (`auth.as.consent.remembered`) and the four ways a consent request can be
// unusable. A remembered grant must not mint a code on a bare GET where a cross-site link can reach
// it, and each dead request says which way it died.
import { afterEach, describe, expect, it } from "vitest";
import {
  authorize,
  CLIENT_REDIRECT,
  cleanupFlows,
  codeOf,
  consentPage,
  consentPost,
  handleOf,
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
type Flow = Awaited<ReturnType<typeof makeFlow>>;

const codes = (flow: Flow) => rows(flow, "SELECT 1 FROM auth_codes");
const live = (flow: Flow) =>
  rows(flow, "SELECT 1 FROM auth_requests WHERE used_at IS NULL AND expires_at > ?", flow.clock.t);
const loopbackAt = (port: number) => ({
  client_id: LOOPBACK_CLIENT,
  redirect_uri: `http://localhost:${port}/cb`,
});

/** First approval (creates the grant), then a second authorize that lands on consent. */
async function remembered(flow: Flow, over: Record<string, string> = {}) {
  const jar = new Jar();
  expect((await obtainCode(flow, jar, challenge, over)).code).not.toBe("");
  flow.clock.t += 20 * MIN;
  const a = await authorize(flow, jar, challenge, over);
  const location = a.headers.get("location") ?? "";
  expect(location).toMatch(/^\/oauth\/consent\?request=/);
  return { jar, handle: handleOf(location), location };
}

/** Load the Continue page for `handle` and submit it with `decision`. */
async function answer(flow: Flow, jar: Jar, handle: string, decision = "approve") {
  const page = await consentPage(flow, jar, handle);
  return consentPost(flow, jar, { csrf: page.csrf, request: handle, decision, remembered: "1" });
}

/** A remembered sign-in whose grant changed after its Continue page: the POST issues nothing. */
async function afterChange(flow: Flow, change: string) {
  const { jar, handle } = await remembered(flow);
  const page = await consentPage(flow, jar, handle);
  flow.db.prepare(change).run();
  const before = codes(flow).length;
  const done = await consentPost(flow, jar, {
    csrf: page.csrf,
    request: handle,
    decision: "approve",
    remembered: "1",
  });
  expect(codes(flow)).toHaveLength(before);
  return { handle, location: done.res.headers.get("location") };
}

describe("auth.as.consent.remembered: the default confirms on a hosted redirect", () => {
  it("a bare GET shows a confirmation page and issues nothing; the handle stays usable", async () => {
    const flow = await makeFlow();
    const { jar, location } = await remembered(flow);
    const before = codes(flow).length;
    for (let i = 0; i < 2; i++) {
      const page = await get(flow, location, jar);
      expect(page.res.status).toBe(200);
      expect(page.res.headers.get("location")).toBeNull();
      expect(page.text).toContain("Continue");
      expect(page.text).toContain("app.example");
      expect(page.text).toContain('name="remembered" value="1"');
    }
    expect(codes(flow)).toHaveLength(before);
    expect(live(flow)).toHaveLength(1);
  });

  it("the confirmation POST, with the page's token, reuses the grant and redirects with a code", async () => {
    const flow = await makeFlow();
    const { jar, handle } = await remembered(flow);
    const done = await answer(flow, jar, handle);
    expect(done.res.status).toBe(303);
    const loc = new URL(done.res.headers.get("location") ?? "");
    expect(loc.origin + loc.pathname).toBe(CLIENT_REDIRECT);
    expect(codeOf(done.res.headers.get("location"))).not.toBe("");
    expect(rows(flow, "SELECT 1 FROM grants")).toHaveLength(1);
  });

  it("the confirmation POST without the token approves nothing", async () => {
    const flow = await makeFlow();
    const { jar, handle } = await remembered(flow);
    const before = codes(flow).length;
    const res = await consentPost(flow, jar, {
      request: handle,
      decision: "approve",
      remembered: "1",
    });
    expect(res.res.status).toBe(403);
    expect(codes(flow)).toHaveLength(before);
  });

  it("cancel on the confirmation page returns access_denied", async () => {
    const flow = await makeFlow();
    const { jar, handle } = await remembered(flow);
    const done = await answer(flow, jar, handle, "deny");
    expect(new URL(done.res.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "access_denied",
    );
  });

  it("a grant narrowed after the confirmation page sends the browser to the full consent page", async () => {
    const flow = await makeFlow();
    const { handle, location } = await afterChange(
      flow,
      "UPDATE users SET scopes_allowed = 'write:notes'",
    );
    expect(location).toBe(`/oauth/consent?request=${handle}`);
    expect(live(flow)).toHaveLength(1);
  });

  it("a grant revoked after the confirmation page needs a fresh sign-in, and issues nothing", async () => {
    const flow = await makeFlow();
    const { handle, location } = await afterChange(flow, "UPDATE grants SET revoked_at = 1");
    expect(location).toBe(`/oauth/login?request=${handle}&reauth=1`);
  });

  it("a loopback redirect stays silent by default", async () => {
    const flow = await makeFlow();
    const { jar, location } = await remembered(flow, loopbackAt(5001));
    const via = await get(flow, location, jar);
    expect(via.res.status).toBe(303);
    expect(codeOf(via.res.headers.get("location"))).not.toBe("");
  });
});

describe("auth.as.consent.remembered set explicitly", () => {
  it("silent: a hosted redirect is approved on the GET, as before", async () => {
    const flow = await makeFlow({ as: { consent: { remembered: "silent" } } });
    const { jar, location } = await remembered(flow);
    const via = await get(flow, location, jar);
    expect(via.res.status).toBe(303);
    expect(codeOf(via.res.headers.get("location"))).not.toBe("");
  });

  it("confirm: a loopback redirect shows the confirmation page too", async () => {
    const flow = await makeFlow({ as: { consent: { remembered: "confirm" } } });
    const { jar, location } = await remembered(flow, loopbackAt(5001));
    const via = await get(flow, location, jar);
    expect(via.res.status).toBe(200);
    expect(via.text).toContain('name="remembered" value="1"');
  });
});

describe("a dead consent request says why", () => {
  it("malformed, unknown, expired and already used each get their own page and log line", async () => {
    const flow = await makeFlow({ as: { consent: { remembered: "confirm" } } });
    const jar = new Jar();
    const first = await obtainCode(flow, jar, challenge);
    expect(first.code).not.toBe("");

    const malformed = await get(flow, "/oauth/consent?request=cut-short", jar);
    expect(malformed.res.status).toBe(400);
    expect(malformed.text).toContain("incomplete or damaged");

    const unknown = await get(flow, `/oauth/consent?request=${"A".repeat(43)}`, jar);
    expect(unknown.res.status).toBe(400);
    expect(unknown.text).toContain("no record of this sign-in request");

    const a = await authorize(flow, jar, challenge);
    const handle = handleOf(a.headers.get("location"));
    await answer(flow, jar, handle);
    const used = await get(flow, `/oauth/consent?request=${handle}`, jar);
    expect(used.res.status).toBe(400);
    expect(used.text).toContain("already completed or cancelled");

    const b = await authorize(flow, jar, challenge);
    const stale = handleOf(b.headers.get("location"));
    flow.clock.t += 11 * MIN;
    const expired = await get(flow, `/oauth/consent?request=${stale}`, jar);
    expect(expired.res.status).toBe(400);
    expect(expired.text).toContain("expired");
    expect(expired.text).not.toContain("already completed");

    for (const reason of ["malformed", "unknown", "used", "expired"]) {
      expect(flow.logs.some((l) => l.includes(`consent refused reason=${reason}`))).toBe(true);
    }
  });

  it("a denied request reads as already used, and a second POST on it says so", async () => {
    const flow = await makeFlow();
    const jar = new Jar();
    const handle = handleOf((await authorize(flow, jar, challenge)).headers.get("location"));
    await loginFor(flow, jar, `/oauth/login?request=${handle}`);
    const page = await consentPage(flow, jar, handle);
    await consentPost(flow, jar, { csrf: page.csrf, request: handle, decision: "deny" });
    const again = await consentPost(flow, jar, {
      csrf: page.csrf,
      request: handle,
      decision: "approve",
    });
    expect(again.res.status).toBe(400);
    expect(again.text).toContain("already completed or cancelled");
  });
});
