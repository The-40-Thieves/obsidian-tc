// What an unauthenticated caller can spend on the passkey routes (design v2 section 4.11, slice S10,
// review round 1): `login/options` is open to anyone who loads the login page, so the challenges it
// hands out are budgeted per source and capped per purpose (a flood of login challenges must not take
// enrolment's room), and the failures of `login/verify` are counted per credential beside the source
// (behind a loopback proxy every caller is "unattributed", and one shared bucket would let anyone lock
// the operator out of passkey login).
import { describe, expect, it } from "vitest";
import {
  MAX_PENDING_LOGIN_CHALLENGES,
  MAX_PENDING_REGISTER_CHALLENGES,
  storeChallenge,
} from "../src/auth/as-passkey-store";
import {
  claimViaSetup,
  get,
  ISSUER,
  Jar,
  login,
  makeOperator,
  type OperatorFixture,
} from "./as-operator-harness";
import { VirtualAuthenticator } from "./webauthn-authenticator";

const RP_ID = new URL(ISSUER).hostname;
const csrfOfMount = (html: string): string =>
  /id="passkey"[^>]*data-csrf="([^"]+)"/.exec(html)?.[1] ?? "";

async function postJson(
  op: OperatorFixture,
  path: string,
  body: unknown,
  jar: Jar,
  csrf: string,
  ip?: string,
) {
  const cookie = jar.header();
  const res = await op.app.request(op.url(path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: op.issuer,
      "x-csrf-token": csrf,
      ...(cookie ? { cookie } : {}),
      ...(ip !== undefined ? { "x-test-ip": ip } : {}),
    },
    body: JSON.stringify(body),
  });
  jar.apply(res);
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

async function claimed(opts: Parameters<typeof makeOperator>[0] = {}) {
  const op = await makeOperator(opts);
  await claimViaSetup(op);
  return op;
}

interface Page {
  jar: Jar;
  csrf: string;
}
/** The login page as a browser loads it: the nonce cookie and the form token bound to it. */
const loginPage = async (op: OperatorFixture, jar = new Jar()): Promise<Page> => ({
  jar,
  csrf: csrfOfMount((await get(op, "/oauth/login", jar)).text),
});

const pending = (op: OperatorFixture, purpose: string): number =>
  (
    op.db
      .prepare("SELECT COUNT(*) AS n FROM webauthn_challenges WHERE purpose = ?")
      .get(purpose) as { n: number }
  ).n;

/** Ask for login options `times` times from `ip`; the status of each answer. */
async function askOptions(op: OperatorFixture, page: Page, times: number, ip?: string) {
  const out: number[] = [];
  for (let i = 0; i < times; i++) {
    out.push(
      (await postJson(op, "/oauth/passkey/login/options", {}, page.jar, page.csrf, ip)).status,
    );
  }
  return out;
}

describe("login/options: a budget per source", () => {
  it("RED: one source is cut off long before the pending-challenge cap, and its refusal says when to retry", async () => {
    const op = await claimed();
    const page = await loginPage(op);
    const statuses = await askOptions(op, page, MAX_PENDING_LOGIN_CHALLENGES + 20, "203.0.113.7");
    const firstRefused = statuses.findIndex((s) => s !== 200);
    expect(firstRefused).toBeGreaterThan(0);
    expect(statuses[firstRefused]).toBe(429);
    expect(pending(op, "login")).toBeLessThan(MAX_PENDING_LOGIN_CHALLENGES / 2);
    expect(pending(op, "login")).toBe(firstRefused);
    const res = await op.app.request(op.url("/oauth/passkey/login/options"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: op.issuer,
        "x-csrf-token": page.csrf,
        cookie: page.jar.header(),
        "x-test-ip": "203.0.113.7",
      },
      body: "{}",
    });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("another source, and the same source a little later, still get a challenge", async () => {
    const op = await claimed();
    const page = await loginPage(op);
    await askOptions(op, page, 200, "203.0.113.7");
    expect(await askOptions(op, page, 1, "203.0.113.7")).toEqual([429]);
    expect(await askOptions(op, page, 1, "198.51.100.20")).toEqual([200]);
    op.clock.t += 60_000;
    expect(await askOptions(op, page, 1, "203.0.113.7")).toEqual([200]);
  });

  it("RED: unattributed peers (loopback proxy, unknown address) share one fallback bucket", async () => {
    const op = await claimed();
    const page = await loginPage(op);
    const statuses = await askOptions(op, page, MAX_PENDING_LOGIN_CHALLENGES + 20);
    expect(statuses.findIndex((s) => s !== 200)).toBeGreaterThan(0);
    expect(statuses).toContain(429);
    expect(pending(op, "login")).toBeLessThan(MAX_PENDING_LOGIN_CHALLENGES / 2);
    // An attributable source is not charged to the fallback bucket.
    expect(await askOptions(op, page, 1, "198.51.100.20")).toEqual([200]);
  });
});

describe("pending challenges: a cap per purpose", () => {
  const T = 1_800_000_000_000;
  const fill = (op: OperatorFixture, purpose: "login" | "register", n: number) => {
    let stored = 0;
    for (let i = 0; i < n; i++) {
      if (
        storeChallenge(op.db, {
          challenge: `${purpose}-${i}`,
          purpose,
          sub: purpose === "register" ? "usr_x" : null,
          now: T,
        })
      ) {
        stored++;
      }
    }
    return stored;
  };

  it("RED: login challenges stop at their own cap, and enrolment still gets one", async () => {
    const op = await claimed();
    expect(fill(op, "login", MAX_PENDING_LOGIN_CHALLENGES + 50)).toBe(MAX_PENDING_LOGIN_CHALLENGES);
    expect(
      storeChallenge(op.db, { challenge: "enrol", purpose: "register", sub: "usr_x", now: T }),
    ).toBe(true);
  });

  it("enrolment challenges stop at their own cap, and login still gets one", async () => {
    const op = await claimed();
    expect(fill(op, "register", MAX_PENDING_REGISTER_CHALLENGES + 50)).toBe(
      MAX_PENDING_REGISTER_CHALLENGES,
    );
    expect(storeChallenge(op.db, { challenge: "in", purpose: "login", sub: null, now: T })).toBe(
      true,
    );
  });

  it("RED: with the login room full, a signed-in operator can still enrol over HTTP", async () => {
    const op = await claimed();
    fill(op, "login", MAX_PENDING_LOGIN_CHALLENGES + 50);
    const jar = new Jar();
    await login(op, jar);
    const csrf = csrfOfMount((await get(op, "/oauth/account", jar)).text);
    const opts = await postJson(op, "/oauth/passkey/register/options", {}, jar, csrf);
    expect(opts.status).toBe(200);
    const page = await loginPage(op);
    const full = await postJson(
      op,
      "/oauth/passkey/login/options",
      {},
      page.jar,
      page.csrf,
      "192.0.2.1",
    );
    expect(full.status).toBe(503);
  });
});

describe("login/verify: failures are counted per credential beside the source", () => {
  /** Sign in with the password and enrol a passkey. */
  async function enrolled(op: OperatorFixture) {
    const auth = new VirtualAuthenticator(ISSUER, RP_ID);
    const jar = new Jar();
    await login(op, jar);
    const csrf = csrfOfMount((await get(op, "/oauth/account", jar)).text);
    const opts = await postJson(op, "/oauth/passkey/register/options", {}, jar, csrf);
    const done = await postJson(
      op,
      "/oauth/passkey/register/verify",
      { response: auth.register(opts.body as never) },
      jar,
      csrf,
    );
    expect(done.status).toBe(200);
    return auth;
  }

  /** One sign-in attempt: options from `optionsIp`, the assertion posted from `verifyIp`. */
  async function attempt(
    op: OperatorFixture,
    auth: VirtualAuthenticator,
    optionsIp: string,
    verifyIp?: string,
  ) {
    const { jar, csrf } = await loginPage(op);
    const opts = await postJson(op, "/oauth/passkey/login/options", {}, jar, csrf, optionsIp);
    expect(opts.status).toBe(200);
    return postJson(
      op,
      "/oauth/passkey/login/verify",
      { response: auth.assert(opts.body as never) },
      jar,
      csrf,
      verifyIp,
    );
  }

  it("RED: an unattributed attacker's failures on other credentials cannot lock the operator out", async () => {
    const op = await claimed();
    const auth = await enrolled(op);
    const stranger = new VirtualAuthenticator(ISSUER, RP_ID);
    for (let i = 0; i < 30; i++) {
      const r = await attempt(op, stranger, `198.51.100.${i + 1}`);
      expect(r.status).toBe(401);
    }
    auth.counter = 20;
    const ok = await attempt(op, auth, "192.0.2.50");
    expect(ok.status).toBe(200);
  });

  it("RED: one credential's failures lock that credential, wherever they came from", async () => {
    const op = await claimed({ as: { login: { maxFailuresPerWindow: 2, windowSeconds: 900 } } });
    const auth = await enrolled(op);
    auth.counter = 9;
    expect((await attempt(op, auth, "192.0.2.1", "192.0.2.1")).status).toBe(200); // stored = 10
    for (const [i, seen] of [3, 4].entries()) {
      auth.counter = seen; // reports 4, then 5: both <= 10, a replay
      const r = await attempt(op, auth, `192.0.2.${i + 10}`, `192.0.2.${i + 10}`);
      expect(r.status).toBe(401);
    }
    auth.counter = 40;
    const locked = await attempt(op, auth, "192.0.2.77", "192.0.2.77");
    expect(locked.status).toBe(429);
  });

  it("a success forgets the credential's failures", async () => {
    const op = await claimed({ as: { login: { maxFailuresPerWindow: 2, windowSeconds: 900 } } });
    const auth = await enrolled(op);
    auth.counter = 9;
    expect((await attempt(op, auth, "192.0.2.1", "192.0.2.1")).status).toBe(200);
    auth.counter = 3;
    expect((await attempt(op, auth, "192.0.2.2", "192.0.2.2")).status).toBe(401);
    auth.counter = 40;
    expect((await attempt(op, auth, "192.0.2.3", "192.0.2.3")).status).toBe(200);
    auth.counter = 3;
    expect((await attempt(op, auth, "192.0.2.4", "192.0.2.4")).status).toBe(401);
    auth.counter = 80;
    expect((await attempt(op, auth, "192.0.2.5", "192.0.2.5")).status).toBe(200);
  });
});
