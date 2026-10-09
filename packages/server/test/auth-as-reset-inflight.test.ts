// `auth as reset-credentials` against operations that were already in flight (design v2 section
// 4.11.5, slice S10, review round 1). A reset changes the password, ends every session, deletes the
// passkeys and challenges and (with --revoke-grants) revokes every grant; none of that may be undone
// by a request that looked at the session BEFORE the reset and writes AFTER it. Each case parks the
// request at the point where it holds a validated session and no lock, runs the reset, and lets the
// request go on:
//   * a passkey registration parked inside the attestation check (the `none` format is unsigned, so
//     any browser can forge one that verifies);
//   * a consent parked between the session lookup and the grant write (a reset from another process
//     can land exactly there).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, lookupSession, setOperatorPassword } from "../src/auth/as-operator-store";
import { resetOperatorCredentials } from "../src/auth/as-passkey-store";
import { hashPassword } from "../src/auth/as-password";
import {
  authorize,
  cleanupFlows,
  consentPage,
  consentPost,
  handleOf,
  loginFor,
  makeFlow,
  pkce,
} from "./as-flow-harness";
import { get, Jar, login, PASSWORD } from "./as-operator-harness";
import { VirtualAuthenticator } from "./webauthn-authenticator";

const hooks = vi.hoisted(() => ({
  /** Awaited inside `verifyRegistration` before the real check runs. */
  verifyGate: undefined as undefined | (() => Promise<void>),
  /** Run just before the real `approveRequest`, i.e. after the handler validated its session. */
  beforeApprove: undefined as undefined | (() => void),
}));

vi.mock("../src/auth/as-passkey", async (orig) => {
  const actual = await orig<typeof import("../src/auth/as-passkey")>();
  return {
    ...actual,
    verifyRegistration: async (...args: Parameters<typeof actual.verifyRegistration>) => {
      await hooks.verifyGate?.();
      return actual.verifyRegistration(...args);
    },
  };
});
vi.mock("../src/auth/as-grants", async (orig) => {
  const actual = await orig<typeof import("../src/auth/as-grants")>();
  return {
    ...actual,
    approveRequest: (...args: Parameters<typeof actual.approveRequest>) => {
      hooks.beforeApprove?.();
      return actual.approveRequest(...args);
    },
  };
});

afterEach(() => {
  hooks.verifyGate = undefined;
  hooks.beforeApprove = undefined;
  cleanupFlows();
});

const RP_ID = "vault.example.com";
const ISSUER = "https://vault.example.com";
const NEW_PASSWORD = "a different passphrase, long enough";
const csrfOfMount = (html: string): string =>
  /id="passkey"[^>]*data-csrf="([^"]+)"/.exec(html)?.[1] ?? "";

type Flow = Awaited<ReturnType<typeof makeFlow>>;

async function postJson(flow: Flow, path: string, body: unknown, jar: Jar, csrf: string) {
  const cookie = jar.header();
  const res = await flow.app.request(flow.url(path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: flow.issuer,
      "x-csrf-token": csrf,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  jar.apply(res);
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

const subOf = (flow: Flow): string =>
  (flow.db.prepare("SELECT sub FROM users").get() as { sub: string }).sub;
const count = (flow: Flow, table: string, where = "1 = 1"): number =>
  (flow.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

/** Signed in, an enrolment challenge issued, the attestation ready to submit. */
async function readyToEnrol(flow: Flow) {
  const jar = new Jar();
  await login(flow, jar);
  const csrf = csrfOfMount((await get(flow, "/oauth/account", jar)).text);
  const opts = await postJson(flow, "/oauth/passkey/register/options", {}, jar, csrf);
  expect(opts.status).toBe(200);
  const auth = new VirtualAuthenticator(ISSUER, RP_ID);
  const verify = () =>
    postJson(
      flow,
      "/oauth/passkey/register/verify",
      { response: auth.register(opts.body as never) },
      jar,
      csrf,
    );
  return { jar, verify };
}

describe("a passkey registration in flight when the credentials are reset", () => {
  it("positive control: without a reset the same registration stores the passkey", async () => {
    const flow = await makeFlow();
    const { verify } = await readyToEnrol(flow);
    expect((await verify()).status).toBe(200);
    expect(count(flow, "webauthn_credentials")).toBe(1);
  });

  it("RED: a reset that lands inside the attestation check leaves no passkey behind", async () => {
    const flow = await makeFlow();
    const { verify } = await readyToEnrol(flow);
    let parked: () => void = () => {};
    const isParked = new Promise<void>((r) => {
      parked = r;
    });
    let release: () => void = () => {};
    hooks.verifyGate = () =>
      new Promise<void>((r) => {
        release = r;
        parked();
      });
    const inflight = verify();
    await isParked;
    resetOperatorCredentials(flow.db, subOf(flow), await hashPassword(NEW_PASSWORD));
    release();
    const r = await inflight;
    expect(r.status).toBe(400);
    expect(count(flow, "webauthn_credentials")).toBe(0);
    expect(count(flow, "sessions")).toBe(0);
  });

  it("RED: a session that predates a password change cannot enrol either", async () => {
    const flow = await makeFlow();
    const { verify } = await readyToEnrol(flow);
    let parked: () => void = () => {};
    const isParked = new Promise<void>((r) => {
      parked = r;
    });
    let release: () => void = () => {};
    hooks.verifyGate = () =>
      new Promise<void>((r) => {
        release = r;
        parked();
      });
    const inflight = verify();
    await isParked;
    setOperatorPassword(flow.db, subOf(flow), await hashPassword(NEW_PASSWORD));
    release();
    expect((await inflight).status).toBe(400);
    expect(count(flow, "webauthn_credentials")).toBe(0);
  });
});

describe("a consent in flight when the credentials are reset with --revoke-grants", () => {
  const { challenge } = pkce();

  /** A completed first authorization, then a second request parked on its consent page. */
  async function parkedConsent(flow: Flow) {
    const jar = new Jar();
    const a = await authorize(flow, jar, challenge, {});
    const next = a.headers.get("location") ?? "";
    const handle = handleOf(next);
    await loginFor(flow, jar, next);
    const page = await consentPage(flow, jar, handle);
    return {
      jar,
      approve: () =>
        consentPost(flow, jar, { csrf: page.csrf, request: page.request, decision: "approve" }),
    };
  }

  const resetWithRevocation = async (flow: Flow) =>
    resetOperatorCredentials(flow.db, subOf(flow), await hashPassword(NEW_PASSWORD), {
      revoke: { registry: flow.registry, reason: "credentials reset by operator", now: Date.now() },
    });

  it("positive control: without a reset the consent creates the grant and the code", async () => {
    const flow = await makeFlow();
    const { approve } = await parkedConsent(flow);
    expect((await approve()).res.status).toBe(303);
    expect(count(flow, "grants", "revoked_at IS NULL")).toBe(1);
    expect(count(flow, "auth_codes")).toBe(1);
  });

  it("RED: the reset lands between the handler's session lookup and its grant write: no grant, no code, no refresh family", async () => {
    const flow = await makeFlow();
    const { approve } = await parkedConsent(flow);
    const hash = await hashPassword(NEW_PASSWORD);
    const sub = subOf(flow);
    hooks.beforeApprove = () => {
      resetOperatorCredentials(flow.db, sub, hash, {
        revoke: {
          registry: flow.registry,
          reason: "credentials reset by operator",
          now: Date.now(),
        },
      });
    };
    const done = await approve();
    expect(done.res.headers.get("location") ?? "").not.toContain("code=");
    expect(done.res.headers.get("location")).toMatch(/^\/oauth\/login/);
    expect(count(flow, "grants", "revoked_at IS NULL")).toBe(0);
    expect(count(flow, "grants")).toBe(0);
    expect(count(flow, "auth_codes")).toBe(0);
    expect(count(flow, "refresh_tokens")).toBe(0);
  });

  it("the reset and the revocation of an existing grant are one step: a grant made earlier is revoked with the sessions", async () => {
    const flow = await makeFlow();
    const { approve } = await parkedConsent(flow);
    expect((await approve()).res.status).toBe(303);
    expect(count(flow, "grants", "revoked_at IS NULL")).toBe(1);
    const r = await resetWithRevocation(flow);
    expect(r.grants).toMatchObject({ revoked: 1 });
    expect(count(flow, "grants", "revoked_at IS NULL")).toBe(0);
    expect(count(flow, "sessions")).toBe(0);
  });
});

describe("sessions record the credential generation they were opened under", () => {
  it("a session row older than the user's generation is no session at all", async () => {
    const flow = await makeFlow();
    const sub = subOf(flow);
    const id = createSession(flow.db, sub, Date.now());
    expect(lookupSession(flow.db, id, Date.now())).toBeDefined();
    // A generation bump that somehow left the session row behind still ends it.
    flow.db.prepare("UPDATE users SET credential_gen = credential_gen + 1 WHERE sub = ?").run(sub);
    expect(lookupSession(flow.db, id, Date.now())).toBeUndefined();
  });

  it("a reset bumps the generation, and a session opened afterwards carries the new one", async () => {
    const flow = await makeFlow();
    const sub = subOf(flow);
    const gen = () =>
      (
        flow.db.prepare("SELECT credential_gen AS g FROM users WHERE sub = ?").get(sub) as {
          g: number;
        }
      ).g;
    const before = gen();
    resetOperatorCredentials(flow.db, sub, await hashPassword(NEW_PASSWORD));
    expect(gen()).toBe(before + 1);
    const jar = new Jar();
    await login(flow, jar, { username: "operator", password: NEW_PASSWORD });
    expect(
      (flow.db.prepare("SELECT credential_gen AS g FROM sessions").get() as { g: number }).g,
    ).toBe(before + 1);
    expect(PASSWORD).not.toBe(NEW_PASSWORD);
  });
});
