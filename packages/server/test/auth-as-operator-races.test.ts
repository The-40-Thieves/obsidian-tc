// Races around the operator login (slice S4 security review): a password reset or a disable that
// lands while a login is still verifying, a revocation that lands between a session lookup's read
// and its touch, the cold-start timing of an unknown name, and concurrent attempts crossing the
// brute-force budget. Each case drives the interleaving deterministically with a gated verifier.
import { describe, expect, it } from "vitest";
import { claimOperator, createSession, lookupSession } from "../src/auth/as-operator-store";
import { ARGON2_PARAMS, hashPassword, verifyPassword } from "../src/auth/as-password";
import { provisionOauthDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import {
  claimViaSetup,
  Jar,
  login,
  makeOperator,
  PASSWORD,
  sessionCookieName,
  sessionRows,
  T0,
  userRows,
} from "./as-operator-harness";
import { openMemoryDb } from "./helpers";

// Argon2 verification is real in these cases and slow on a loaded box: the budget is spelled out
// rather than left to vitest's 5 s default, which the heaviest of them overran under load.
const ARGON_BUDGET_MS = 30_000;

const GOOD = { username: "operator", password: PASSWORD };
const BAD = { username: "operator", password: "definitely the wrong password" };

/** A verifier that finishes the real check, then waits at a gate the test opens. */
function gatedVerifier(onlyWrong = false) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const seen: string[] = [];
  let armed = true;
  return {
    seen,
    release: () => release(),
    disarm: () => {
      armed = false;
    },
    verify: async (password: string, phc: string): Promise<boolean> => {
      seen.push(phc);
      const ok = await verifyPassword(password, phc);
      if (armed && (!onlyWrong || !ok)) await gate;
      return ok;
    },
  };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1500 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error("condition never became true");
}

describe("a login that is still verifying when the account changes", () => {
  it(
    "is refused after a password reset: no session, and the new password is left alone",
    async () => {
      const g = gatedVerifier();
      const op = await makeOperator({ verify: g.verify });
      await claimViaSetup(op);
      const { setOperatorPassword } = await import("../src/auth/as-operator-store");
      const jar = new Jar();
      const inflight = login(op, jar, GOOD);
      await until(() => g.seen.length === 1);
      const fresh = await hashPassword("a brand new passphrase");
      setOperatorPassword(op.db, userRows(op)[0]?.sub ?? "", fresh);
      g.release();
      const r = await inflight;
      expect(r.res.status).toBe(401);
      expect(sessionCookieName(jar)).toBeUndefined();
      expect(sessionRows(op)).toHaveLength(0);
      expect(userRows(op)[0]?.password_hash).toBe(fresh);
    },
    ARGON_BUDGET_MS,
  );

  it(
    "never overwrites a newly set password with a rehash of the old one",
    async () => {
      const g = gatedVerifier();
      const op = await makeOperator({ verify: g.verify });
      await claimViaSetup(op);
      const weak = await hashPassword(PASSWORD, { ...ARGON2_PARAMS, memory: 8192, passes: 1 });
      op.db.prepare("UPDATE users SET password_hash = ?").run(weak);
      const { setOperatorPassword } = await import("../src/auth/as-operator-store");
      const inflight = login(op, new Jar(), GOOD);
      await until(() => g.seen.length === 1);
      const fresh = await hashPassword("a brand new passphrase");
      setOperatorPassword(op.db, userRows(op)[0]?.sub ?? "", fresh);
      g.release();
      expect((await inflight).res.status).toBe(401);
      expect(userRows(op)[0]?.password_hash).toBe(fresh);
      expect(sessionRows(op)).toHaveLength(0);
    },
    ARGON_BUDGET_MS,
  );

  it(
    "is refused after the operator is disabled",
    async () => {
      const g = gatedVerifier();
      const op = await makeOperator({ verify: g.verify });
      await claimViaSetup(op);
      const jar = new Jar();
      const inflight = login(op, jar, GOOD);
      await until(() => g.seen.length === 1);
      op.db.prepare("UPDATE users SET disabled_at = ?").run(T0);
      g.release();
      expect((await inflight).res.status).toBe(401);
      expect(sessionCookieName(jar)).toBeUndefined();
      expect(sessionRows(op)).toHaveLength(0);
    },
    ARGON_BUDGET_MS,
  );
});

describe("a session lookup racing a revocation", () => {
  /** A connection whose next UPDATE of `sessions` is preceded by `revoke`, as if another process
   *  had acted between this lookup's read and its touch. */
  function revokedBeforeTouch(db: Database, revoke: () => void): Database {
    let fired = false;
    const fire = () => {
      if (!fired) {
        fired = true;
        revoke();
      }
    };
    return new Proxy(db, {
      get(target, key) {
        if (key === "prepare") {
          return (sql: string) => {
            const st = target.prepare(sql);
            if (!/^\s*UPDATE\s+sessions/i.test(sql)) return st;
            const around =
              <A extends unknown[], R>(f: (...a: A) => R) =>
              (...a: A): R => {
                fire();
                return f.apply(st, a);
              };
            return { run: around(st.run), get: around(st.get), all: around(st.all) };
          };
        }
        const v = Reflect.get(target, key) as unknown;
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  function fixture() {
    const db = openMemoryDb();
    provisionOauthDb(db, { version: "t" });
    const claim = claimOperator(db, { username: "operator", passwordHash: "x", now: T0 });
    if (!claim.ok) throw new Error("claim failed");
    const id = createSession(db, claim.sub, T0);
    return { db, sub: claim.sub, id };
  }

  const revocations: Array<[string, (db: Database, sub: string) => void]> = [
    ["the session is deleted", (db) => void db.prepare("DELETE FROM sessions").run()],
    [
      "the password is reset (every session of the user is deleted)",
      (db, sub) => {
        db.prepare("UPDATE users SET password_hash = 'y' WHERE sub = ?").run(sub);
        db.prepare("DELETE FROM sessions WHERE sub = ?").run(sub);
      },
    ],
    [
      "the user is disabled",
      (db, sub) => void db.prepare("UPDATE users SET disabled_at = ? WHERE sub = ?").run(T0, sub),
    ],
  ];

  it.each(revocations)("does not authenticate when %s just before the touch", (_name, revoke) => {
    const { db, sub, id } = fixture();
    const racing = revokedBeforeTouch(db, () => revoke(db, sub));
    expect(lookupSession(racing, id, T0 + 1000)).toBeUndefined();
    expect(db.prepare("SELECT 1 AS n FROM sessions").get()).toBeUndefined();
  });

  it("still authenticates and slides an unrevoked session", () => {
    const { db, sub, id } = fixture();
    const info = lookupSession(db, id, T0 + 60_000);
    expect(info?.sub).toBe(sub);
    expect(info?.username).toBe("operator");
    const row = db.prepare("SELECT last_seen_at AS seen FROM sessions").get() as { seen: number };
    expect(row.seen).toBe(T0 + 60_000);
  });
});

describe("a name that does not exist costs what a real one costs, from the first request", () => {
  it(
    "verifies an unknown name against the operator's own hash, creating no dummy hash",
    async () => {
      const seen: string[] = [];
      const op = await makeOperator({
        verify: (p, phc) => {
          seen.push(phc);
          return verifyPassword(p, phc);
        },
      });
      await claimViaSetup(op);
      const stored = userRows(op)[0]?.password_hash;
      const hashesBefore = op.calls.hash;
      const r = await login(op, new Jar(), { username: "nobody", password: BAD.password });
      expect(r.res.status).toBe(401);
      expect(seen).toEqual([stored]);
      expect(op.calls.hash).toBe(hashesBefore);
    },
    ARGON_BUDGET_MS,
  );

  it(
    "refuses the operator's real password under another name",
    async () => {
      const op = await makeOperator();
      await claimViaSetup(op);
      const jar = new Jar();
      const r = await login(op, jar, { username: "nobody", password: PASSWORD });
      expect(r.res.status).toBe(401);
      expect(sessionCookieName(jar)).toBeUndefined();
      expect(sessionRows(op)).toHaveLength(0);
    },
    ARGON_BUDGET_MS,
  );
});

describe("concurrent attempts cannot cross the brute-force budget together", () => {
  it(
    "refuses a correct attempt that starts while the budget is already spoken for",
    async () => {
      const g = gatedVerifier();
      const op = await makeOperator({
        verify: g.verify,
        as: { login: { maxFailuresPerWindow: 2, windowSeconds: 120 } },
      });
      await claimViaSetup(op);
      const wrong = [login(op, new Jar(), BAD), login(op, new Jar(), BAD)];
      await until(() => g.seen.length === 2);
      const jar = new Jar();
      const correct = login(op, jar, GOOD);
      await new Promise((r) => setTimeout(r, 150));
      g.release();
      const statuses = (await Promise.all([...wrong, correct])).map((r) => r.res.status);
      expect(statuses).toEqual([401, 401, 429]);
      expect(sessionCookieName(jar)).toBeUndefined();
      expect(sessionRows(op)).toHaveLength(0);
    },
    ARGON_BUDGET_MS,
  );

  it(
    "holds one source address to its budget across concurrent attempts on different accounts",
    async () => {
      const g = gatedVerifier();
      const op = await makeOperator({
        verify: g.verify,
        maxConcurrentHashes: 10,
        as: { login: { maxFailuresPerWindow: 1, windowSeconds: 120 } },
      });
      await claimViaSetup(op);
      const headers = { "x-test-ip": "203.0.113.9" };
      const spray = Array.from({ length: 4 }, (_, i) =>
        login(op, new Jar(), { username: `guess${i}`, password: BAD.password }, { headers }),
      );
      await until(() => g.seen.length === 4);
      const correct = login(op, new Jar(), GOOD, { headers });
      await new Promise((r) => setTimeout(r, 150));
      g.release();
      const statuses = (await Promise.all([...spray, correct])).map((r) => r.res.status);
      expect(statuses).toEqual([401, 401, 401, 401, 429]);
    },
    ARGON_BUDGET_MS,
  );

  it(
    "gives a reservation back when the attempt is shed as busy",
    async () => {
      const g = gatedVerifier();
      const op = await makeOperator({
        verify: g.verify,
        maxConcurrentHashes: 1,
        as: { login: { maxFailuresPerWindow: 2, windowSeconds: 120 } },
      });
      await claimViaSetup(op);
      const first = login(op, new Jar(), BAD);
      await until(() => g.seen.length === 1);
      const shed = await login(op, new Jar(), BAD);
      expect(shed.res.status).toBe(503);
      g.disarm();
      g.release();
      expect((await first).res.status).toBe(401);
      // One failure is on the books, nothing is in flight: the next real attempt is allowed.
      expect((await login(op, new Jar(), GOOD)).res.status).toBe(303);
    },
    ARGON_BUDGET_MS,
  );

  it(
    "keeps the reservations of attempts still in flight when another one succeeds",
    async () => {
      const g = gatedVerifier(true);
      const op = await makeOperator({
        verify: g.verify,
        as: { login: { maxFailuresPerWindow: 2, windowSeconds: 120 } },
      });
      await claimViaSetup(op);
      const wrong1 = login(op, new Jar(), BAD);
      await until(() => g.seen.length === 1);
      // A correct login settles while wrong1 is still verifying, then a second wrong one starts.
      expect((await login(op, new Jar(), GOOD)).res.status).toBe(303);
      const wrong2 = login(op, new Jar(), BAD);
      await until(() => g.seen.length === 3);
      const jar = new Jar();
      const correct = login(op, jar, GOOD);
      await new Promise((r) => setTimeout(r, 150));
      g.release();
      const statuses = (await Promise.all([wrong1, wrong2, correct])).map((r) => r.res.status);
      expect(statuses).toEqual([401, 401, 429]);
      expect(sessionCookieName(jar)).toBeUndefined();
    },
    ARGON_BUDGET_MS,
  );

  it(
    "gives a reservation back when the attempt succeeds, and forgets earlier failures",
    async () => {
      const op = await makeOperator({
        as: { login: { maxFailuresPerWindow: 2, windowSeconds: 120 } },
      });
      await claimViaSetup(op);
      for (let round = 0; round < 3; round++) {
        expect((await login(op, new Jar(), BAD)).res.status).toBe(401);
        expect((await login(op, new Jar(), GOOD)).res.status).toBe(303);
      }
    },
    ARGON_BUDGET_MS,
  );
});
