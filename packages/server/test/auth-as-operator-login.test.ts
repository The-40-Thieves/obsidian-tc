// Operator login for the bundled authorization server (design v2 sections 4.3, 4.5 and 8), slice S4:
// brute-force limits, the session cookie and its server-side store, CSRF, clickjacking headers, 303
// after POST, and no secret in any log line. Claiming the server is in auth-as-operator.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimViaSetup,
  get,
  ISSUER,
  Jar,
  login,
  MIN,
  makeOperator,
  PASSWORD,
  post,
  SETUP_TOKEN,
  sessionCookieName,
  sessionRows,
  sha256,
  submit,
  T0,
  userRows,
} from "./as-operator-harness";

const HOUR = 3_600_000;
const CSP = "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'";
const GOOD = { username: "operator", password: PASSWORD };
const BAD = { username: "operator", password: "definitely the wrong password" };

afterEach(() => vi.restoreAllMocks());

/** A second enabled user, so the server stays claimed while the first is disabled. */
function addSecondUser(op: Awaited<ReturnType<typeof makeOperator>>): void {
  op.db
    .prepare("INSERT INTO users (sub, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(
      "usr_second",
      "second",
      "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      T0,
    );
}

async function claimed(opts: Parameters<typeof makeOperator>[0] = {}) {
  const op = await makeOperator(opts);
  await claimViaSetup(op);
  return op;
}

describe("login brute force (per account, per IP, no enumeration)", () => {
  it("refuses the 6th attempt even with the RIGHT password, until the backoff elapses", async () => {
    const op = await claimed();
    const jar = new Jar();
    for (let i = 0; i < 5; i++) {
      const r = await login(op, jar, BAD);
      expect(r.res.status, `attempt ${i + 1}`).toBe(401);
    }
    const locked = await login(op, jar, GOOD);
    expect(locked.res.status).toBe(429);
    expect(locked.res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(sessionCookieName(jar)).toBeUndefined();
    expect(sessionRows(op)).toHaveLength(0);

    op.clock.t += 29_000;
    expect((await login(op, jar, GOOD)).res.status).toBe(429);
    op.clock.t += 2_000;
    expect((await login(op, jar, GOOD)).res.status).toBe(303);
  });

  it("backs off exponentially: each further failure doubles the lock", async () => {
    const op = await claimed();
    const jar = new Jar();
    for (let i = 0; i < 5; i++) await login(op, jar, BAD);
    op.clock.t += 31_000; // first lock (30 s) over
    expect((await login(op, jar, BAD)).res.status).toBe(401); // the 6th failure
    op.clock.t += 59_000;
    expect((await login(op, jar, GOOD)).res.status).toBe(429); // 60 s lock still running
    op.clock.t += 2_000;
    expect((await login(op, jar, GOOD)).res.status).toBe(303);
  });

  it("honours auth.as.login: maxFailuresPerWindow and windowSeconds", async () => {
    const op = await claimed({ as: { login: { maxFailuresPerWindow: 2, windowSeconds: 120 } } });
    const jar = new Jar();
    await login(op, jar, BAD);
    await login(op, jar, BAD);
    expect((await login(op, jar, GOOD)).res.status).toBe(429);
    // Failures older than the window no longer count.
    op.clock.t += 121_000;
    expect((await login(op, jar, BAD)).res.status).toBe(401);
    expect((await login(op, jar, GOOD)).res.status).toBe(303);
  });

  it("does not count attempts made while locked, so the lock cannot be extended forever", async () => {
    const op = await claimed();
    const jar = new Jar();
    for (let i = 0; i < 5; i++) await login(op, jar, BAD);
    for (let i = 0; i < 20; i++) expect((await login(op, jar, BAD)).res.status).toBe(429);
    op.clock.t += 31_000;
    expect((await login(op, jar, GOOD)).res.status).toBe(303);
  });

  it("forgets earlier failures after a success", async () => {
    const op = await claimed();
    for (let round = 0; round < 3; round++) {
      const jar = new Jar();
      for (let i = 0; i < 4; i++) expect((await login(op, jar, BAD)).res.status).toBe(401);
      expect((await login(op, jar, GOOD)).res.status).toBe(303);
    }
  });

  it("answers an unknown user exactly like a wrong password, and still pays for one verify", async () => {
    const op = await claimed();
    const known = await login(op, new Jar(), BAD);
    const verifiesBefore = op.calls.verify;
    const unknown = await login(op, new Jar(), { username: "nobody", password: BAD.password });
    expect(unknown.res.status).toBe(known.res.status);
    expect(unknown.text.replace(/value="[^"]*"/g, "")).toBe(
      known.text.replace(/value="[^"]*"/g, ""),
    );
    expect(op.calls.verify - verifiesBefore).toBe(1);
  });

  it("locks an unknown user the same way it locks a real one (no enumeration by lockout)", async () => {
    const op = await claimed();
    const trace = async (username: string) => {
      const jar = new Jar();
      const seen: number[] = [];
      for (let i = 0; i < 7; i++) {
        seen.push((await login(op, jar, { username, password: BAD.password })).res.status);
      }
      return seen;
    };
    expect(await trace("operator")).toEqual([401, 401, 401, 401, 401, 429, 429]);
    expect(await trace("ghost")).toEqual([401, 401, 401, 401, 401, 429, 429]);
  });

  it("treats a disabled operator like an unknown one: the same 401, and one verify", async () => {
    const op = await claimed();
    addSecondUser(op);
    op.db.prepare("UPDATE users SET disabled_at = ? WHERE username = 'operator'").run(T0);
    const before = op.calls.verify;
    const r = await login(op, new Jar(), GOOD);
    expect(r.res.status).toBe(401);
    expect(op.calls.verify - before).toBe(1);
  });

  it("is unclaimed again when the only operator is disabled", async () => {
    const op = await claimed();
    op.db.prepare("UPDATE users SET disabled_at = ?").run(T0);
    expect((await login(op, new Jar(), GOOD)).res.status).toBe(503);
  });

  it("limits one source address across many accounts, and leaves other addresses alone", async () => {
    const op = await claimed();
    const spray = async (ip: string, n: number) => {
      const statuses: number[] = [];
      for (let i = 0; i < n; i++) {
        const jar = new Jar();
        statuses.push(
          (
            await login(
              op,
              jar,
              { username: `guess${ip}-${i}`, password: BAD.password },
              {
                headers: { "x-test-ip": ip },
              },
            )
          ).res.status,
        );
      }
      return statuses;
    };
    const first = await spray("203.0.113.9", 21);
    expect(first.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(first[20]).toBe(429);
    // The same address is now refused even for the real operator with the right password.
    const jar = new Jar();
    expect(
      (await login(op, jar, GOOD, { headers: { "x-test-ip": "203.0.113.9" } })).res.status,
    ).toBe(429);
    expect(
      (await login(op, new Jar(), GOOD, { headers: { "x-test-ip": "198.51.100.7" } })).res.status,
    ).toBe(303);
  });

  it("bounds concurrent password verifications instead of queueing unbounded work", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const op = await makeOperator({
      maxConcurrentHashes: 2,
      verify: async () => {
        await gate;
        return false;
      },
    });
    await claimViaSetup(op);
    const attempts = Array.from({ length: 4 }, async (_, i) => {
      const jar = new Jar();
      const page = await get(op, "/oauth/login", jar);
      const fields = { csrf: page.csrf, username: `u${i}`, password: "x".repeat(14) };
      return post(op, "/oauth/login", fields, jar);
    });
    await new Promise((r) => setTimeout(r, 50));
    release();
    const statuses = (await Promise.all(attempts)).map((r) => r.res.status).sort();
    expect(statuses).toEqual([401, 401, 503, 503]);
  });

  it("rejects an oversized body (16 KiB cap) and a non-form content type", async () => {
    const op = await claimed();
    const jar = new Jar();
    const page = await get(op, "/oauth/login", jar);
    const big = await post(
      op,
      "/oauth/login",
      { csrf: page.csrf, username: "a", password: "x".repeat(20_000) },
      jar,
    );
    expect(big.res.status).toBe(413);
    const json = await post(op, "/oauth/login", GOOD, jar, { contentType: "application/json" });
    expect(json.res.status).toBe(415);
  });
});

describe("session cookie and server-side session store", () => {
  it("sets __Host-otc_as, HttpOnly, Secure, SameSite=Lax, Path=/, no Domain, on a https issuer", async () => {
    const op = await claimed();
    const jar = new Jar();
    const r = await login(op, jar);
    expect(r.res.status).toBe(303);
    const line = r.res.headers.getSetCookie().find((c) => c.startsWith("__Host-otc_as=")) ?? "";
    expect(line).toMatch(/;\s*HttpOnly/i);
    expect(line).toMatch(/;\s*Secure/i);
    expect(line).toMatch(/;\s*SameSite=Lax/i);
    expect(line).toMatch(/;\s*Path=\//i);
    expect(line).not.toMatch(/Domain=/i);
    expect(line).toMatch(/Max-Age=\d+/i);
  });

  it("uses the un-prefixed name without Secure only on a loopback http issuer", async () => {
    const op = await claimed({ issuer: "http://127.0.0.1:8765" });
    const jar = new Jar();
    const r = await submit(op, "/oauth/login", GOOD, jar);
    expect(r.res.status).toBe(303);
    const line = r.res.headers.getSetCookie().find((c) => c.startsWith("otc_as=")) ?? "";
    expect(line).toMatch(/;\s*HttpOnly/i);
    expect(line).toMatch(/;\s*SameSite=Lax/i);
    expect(line).not.toMatch(/;\s*Secure/i);
    expect(r.res.headers.getSetCookie().some((c) => c.startsWith("__Host-"))).toBe(false);
  });

  it("stores only the SHA-256 of the session id, with idle and absolute expiry", async () => {
    const op = await claimed();
    const jar = new Jar();
    await login(op, jar);
    const id = jar.cookies.get("__Host-otc_as") ?? "";
    expect(id.length).toBeGreaterThanOrEqual(43);
    const [row] = sessionRows(op);
    expect(row?.id_hash).toBe(sha256(id));
    expect(row?.sub).toBe(userRows(op)[0]?.sub);
    expect(row?.created_at).toBe(T0);
    expect(row?.expires_at).toBe(T0 + 12 * HOUR);
    expect(JSON.stringify(sessionRows(op))).not.toContain(id);
  });

  it("recognises the session on the next request and shows the logout form", async () => {
    const op = await claimed();
    const jar = new Jar();
    await login(op, jar);
    const page = await get(op, "/oauth/login", jar);
    expect(page.res.status).toBe(200);
    expect(page.text).toMatch(/action="\/oauth\/logout"/);
    expect(page.text).not.toMatch(/type="password"/);
  });

  it("issues a NEW session id on every login: a planted id is never adopted (no fixation)", async () => {
    const op = await claimed();
    const jar = new Jar();
    jar.cookies.set("__Host-otc_as", "attacker-chosen-session-id-0123456789abcdefghij");
    const r = await login(op, jar);
    expect(r.res.status).toBe(303);
    const fresh = jar.cookies.get("__Host-otc_as");
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe("attacker-chosen-session-id-0123456789abcdefghij");
    expect(sessionRows(op).map((s) => s.id_hash)).toEqual([sha256(fresh ?? "")]);
  });

  it("drops the old session when the same browser signs in again", async () => {
    const op = await claimed();
    const jar = new Jar();
    await login(op, jar);
    const first = jar.cookies.get("__Host-otc_as") ?? "";
    // Present the old cookie while submitting a fresh login form (e.g. a second tab).
    const tab = new Jar();
    const form = await get(op, "/oauth/login", tab); // no session cookie: a real login form
    tab.cookies.set("__Host-otc_as", first);
    const r = await post(op, "/oauth/login", { csrf: form.csrf, ...GOOD }, tab);
    expect(r.res.status).toBe(303);
    const second = tab.cookies.get("__Host-otc_as");
    expect(second).not.toBe(first);
    expect(sessionRows(op).map((s) => s.id_hash)).toEqual([sha256(second ?? "")]);
  });

  it("expires after 30 minutes idle, and a request inside that window slides it", async () => {
    const op = await claimed();
    const jar = new Jar();
    await login(op, jar);
    op.clock.t += 25 * MIN;
    expect((await get(op, "/oauth/login", jar)).text).toMatch(/\/oauth\/logout/);
    op.clock.t += 25 * MIN; // 50 minutes after login, 25 after the last request
    expect((await get(op, "/oauth/login", jar)).text).toMatch(/\/oauth\/logout/);
    op.clock.t += 31 * MIN; // idle too long
    const page = await get(op, "/oauth/login", jar);
    expect(page.text).toMatch(/type="password"/);
    expect(sessionRows(op)).toHaveLength(0);
  });

  it("expires 12 hours after login however active it is", async () => {
    const op = await claimed();
    const jar = new Jar();
    await login(op, jar);
    for (let i = 0; i < 13; i++) {
      op.clock.t += 55 * MIN;
      await get(op, "/oauth/login", jar);
    }
    op.clock.t += 10 * MIN; // 12 h 5 min after login
    const page = await get(op, "/oauth/login", jar);
    expect(page.text).toMatch(/type="password"/);
    expect(sessionRows(op)).toHaveLength(0);
  });

  it("logs out: 303, the cookie cleared and the row deleted, so the old cookie is dead server-side", async () => {
    const op = await claimed();
    const jar = new Jar();
    await login(op, jar);
    const old = jar.header();
    const page = await get(op, "/oauth/login", jar);
    const out = await post(op, "/oauth/logout", { csrf: page.csrf }, jar);
    expect(out.res.status).toBe(303);
    expect(out.res.headers.get("location")).toBe("/oauth/login");
    expect(out.res.headers.getSetCookie().join("\n")).toMatch(/__Host-otc_as=;|Max-Age=0/i);
    expect(sessionRows(op)).toHaveLength(0);
    const replay = await op.app.request(op.url("/oauth/login"), { headers: { cookie: old } });
    expect(await replay.text()).toMatch(/type="password"/);
  });

  it("does not log out on GET", async () => {
    const op = await claimed();
    const jar = new Jar();
    await login(op, jar);
    const res = await op.app.request(op.url("/oauth/logout"), {
      headers: { cookie: jar.header() },
    });
    expect([404, 405]).toContain(res.status);
    expect(sessionRows(op)).toHaveLength(1);
  });

  it("ends the session of an operator who was disabled", async () => {
    const op = await claimed();
    const jar = new Jar();
    await login(op, jar);
    addSecondUser(op);
    op.db.prepare("UPDATE users SET disabled_at = ? WHERE username = 'operator'").run(T0);
    const page = await get(op, "/oauth/login", jar);
    expect(page.text).toMatch(/type="password"/);
    expect(page.text).not.toMatch(/\/oauth\/logout/);
  });

  it("upgrades a hash made under weaker parameters on a successful login", async () => {
    const op = await claimed();
    const { ARGON2_PARAMS, hashPassword, needsRehash } = await import("../src/auth/as-password");
    const weak = await hashPassword(PASSWORD, { ...ARGON2_PARAMS, memory: 8192, passes: 1 });
    op.db.prepare("UPDATE users SET password_hash = ?").run(weak);
    expect((await login(op, new Jar())).res.status).toBe(303);
    const stored = userRows(op)[0]?.password_hash ?? "";
    expect(stored).not.toBe(weak);
    expect(needsRehash(stored)).toBe(false);
  });
});

describe("CSRF on every state-changing form (CSRF row)", () => {
  it("refuses a login POST with no token, a forged one, or another form's token", async () => {
    const op = await claimed();
    const jar = new Jar();
    const form = await get(op, "/oauth/login", jar);
    const setup = await get(op, "/oauth/setup", new Jar());
    for (const csrf of [undefined, "", "forged", `${form.csrf}x`, setup.csrf]) {
      const r = await post(
        op,
        "/oauth/login",
        { ...(csrf === undefined ? {} : { csrf }), ...GOOD },
        jar,
      );
      expect(r.res.status, String(csrf)).toBe(403);
      expect(r.res.headers.getSetCookie().some((c) => /(^|-)otc_as=[^;]/.test(c))).toBe(false);
    }
    expect(sessionRows(op)).toHaveLength(0);
  });

  it("refuses a valid token presented without the cookie it is bound to", async () => {
    const op = await claimed();
    const form = await get(op, "/oauth/login", new Jar());
    const r = await post(op, "/oauth/login", { csrf: form.csrf, ...GOOD }, new Jar());
    expect(r.res.status).toBe(403);
  });

  it("refuses a token minted for another browser", async () => {
    const op = await claimed();
    const a = new Jar();
    const b = new Jar();
    const formA = await get(op, "/oauth/login", a);
    await get(op, "/oauth/login", b);
    const r = await post(op, "/oauth/login", { csrf: formA.csrf, ...GOOD }, b);
    expect(r.res.status).toBe(403);
  });

  it("requires an Origin equal to the issuer origin on every POST", async () => {
    const op = await claimed();
    for (const origin of [
      "https://evil.example",
      "https://vault.example.com.evil.example",
      "null",
      null,
    ]) {
      const jar = new Jar();
      const form = await get(op, "/oauth/login", jar);
      const r = await post(op, "/oauth/login", { csrf: form.csrf, ...GOOD }, jar, { origin });
      expect(r.res.status, String(origin)).toBe(403);
    }
    const jar = new Jar();
    const form = await get(op, "/oauth/login", jar);
    expect(
      (await post(op, "/oauth/login", { csrf: form.csrf, ...GOOD }, jar, { origin: ISSUER })).res
        .status,
    ).toBe(303);
  });

  it("protects logout: another session's token or a missing Origin leaves the session alive", async () => {
    const op = await claimed();
    const jar = new Jar();
    await login(op, jar);
    const mine = await get(op, "/oauth/login", jar);
    const other = new Jar();
    await login(op, other);
    const theirs = await get(op, "/oauth/login", other);
    for (const attempt of [
      post(op, "/oauth/logout", { csrf: theirs.csrf }, jar),
      post(op, "/oauth/logout", {}, jar),
      post(op, "/oauth/logout", { csrf: mine.csrf }, jar, { origin: null }),
      post(op, "/oauth/logout", { csrf: mine.csrf }, jar, { origin: "https://evil.example" }),
    ]) {
      expect((await attempt).res.status).toBe(403);
    }
    expect(sessionRows(op)).toHaveLength(2);
  });

  it("protects the setup form too", async () => {
    const op = await makeOperator();
    const r = await post(op, "/oauth/setup", {
      csrf: "forged",
      token: SETUP_TOKEN,
      username: "operator",
      password: PASSWORD,
      confirm: PASSWORD,
    });
    expect(r.res.status).toBe(403);
    expect(userRows(op)).toHaveLength(0);
  });
});

describe("every AS response is frame-proof (clickjacking row) and never cached", () => {
  it("carries CSP, X-Frame-Options DENY, no-referrer, no-store and nosniff everywhere", async () => {
    const unclaimed = await makeOperator();
    const op = await claimed();
    const jar = new Jar();
    const form = await get(op, "/oauth/login", jar);
    const out: Array<[string, Response]> = [
      ["unclaimed login", await unclaimed.app.request(unclaimed.url("/oauth/login"))],
      ["unclaimed authorize", await unclaimed.app.request(unclaimed.url("/oauth/authorize"))],
      ["setup form", (await get(unclaimed, "/oauth/setup")).res],
      [
        "setup 404",
        (
          await get(
            await makeOperator({ env: { OBSIDIAN_TC_AS_SETUP_TOKEN: undefined } }),
            "/oauth/setup",
          )
        ).res,
      ],
      ["setup after claim", (await get(op, "/oauth/setup")).res],
      ["login form", form.res],
      ["login 401", (await post(op, "/oauth/login", { csrf: form.csrf, ...BAD }, jar)).res],
      ["login 403", (await post(op, "/oauth/login", { csrf: "x", ...GOOD }, jar)).res],
      [
        "login 413",
        (await post(op, "/oauth/login", { csrf: form.csrf, password: "x".repeat(20000) }, jar)).res,
      ],
      ["login 303", (await login(op, new Jar())).res],
      ["stylesheet", (await get(op, "/oauth/as.css")).res],
    ];
    const signed = new Jar();
    await login(op, signed);
    out.push(["signed in", (await get(op, "/oauth/login", signed)).res]);
    out.push(["logout 403", (await post(op, "/oauth/logout", {}, signed)).res]);
    const page = await get(op, "/oauth/login", signed);
    out.push(["logout 303", (await post(op, "/oauth/logout", { csrf: page.csrf }, signed)).res]);
    for (const [name, res] of out) {
      expect(res.headers.get("content-security-policy"), name).toBe(CSP);
      expect(res.headers.get("x-frame-options"), name).toBe("DENY");
      expect(res.headers.get("referrer-policy"), name).toBe("no-referrer");
      expect(res.headers.get("cache-control"), name).toMatch(/no-store/);
      expect(res.headers.get("x-content-type-options"), name).toBe("nosniff");
    }
    expect(out.length).toBeGreaterThanOrEqual(14);
  });

  it("ships pages the CSP can actually render: no inline script or style, a same-origin stylesheet", async () => {
    const op = await claimed();
    const pages = [
      (await get(op, "/oauth/login")).text,
      (await get(await makeOperator(), "/oauth/setup")).text,
    ];
    for (const html of pages) {
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/\sstyle=/i);
      expect(html).not.toMatch(/\son[a-z]+=/i);
      expect(html).toMatch(/<link rel="stylesheet" href="\/oauth\/as\.css">/);
      expect(html).toMatch(/<form method="post"/);
    }
  });
});

describe("303 after POST (credential re-POST row)", () => {
  it("answers a successful login, claim and logout with exactly 303, and a failure with no redirect", async () => {
    const setupOp = await makeOperator();
    const claim = await submit(setupOp, "/oauth/setup", {
      token: SETUP_TOKEN,
      username: "operator",
      password: PASSWORD,
      confirm: PASSWORD,
    });
    expect(claim.res.status).toBe(303);
    expect(claim.res.headers.get("location")).toBe("/oauth/login");

    const op = await claimed();
    const jar = new Jar();
    const ok = await login(op, jar);
    expect(ok.res.status).toBe(303);
    expect(ok.res.headers.get("location")).toBe("/oauth/login");
    const page = await get(op, "/oauth/login", jar);
    const out = await post(op, "/oauth/logout", { csrf: page.csrf }, jar);
    expect(out.res.status).toBe(303);

    const bad = await login(op, new Jar(), BAD);
    expect(bad.res.status).toBe(401);
    expect(bad.res.headers.get("location")).toBeNull();
  });
});

describe("no secret reaches a log line or the output streams (token leakage row)", () => {
  it("drives a claim, failed logins, a login and a logout without leaking password, token, session or query", async () => {
    const lines: string[] = [];
    const capture = (c: unknown) => {
      lines.push(String(c));
      return true;
    };
    vi.spyOn(process.stderr, "write").mockImplementation(capture as never);
    vi.spyOn(process.stdout, "write").mockImplementation(capture as never);
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      });
    }
    const op = await makeOperator();
    const typed = "TyPeD-secret-in-the-username-box-77";
    await claimViaSetup(op);
    const jar = new Jar();
    await login(op, jar, { username: typed, password: "wrong-password-value-42" });
    await login(op, jar, { username: "operator", password: "wrong-password-value-43" });
    await get(op, "/oauth/login?code=CODE-abc123&state=STATE-xyz&access_token=TOK-zzz", jar);
    const ok = await login(op, jar);
    expect(ok.res.status).toBe(303);
    const session = jar.cookies.get("__Host-otc_as") ?? "";
    const page = await get(op, "/oauth/login", jar);
    await post(op, "/oauth/logout", { csrf: page.csrf }, jar);

    const everything = [...op.logs, ...lines].join("\n");
    // Existence floor: the sinks did receive events, so a clean scan means something.
    expect(op.logs.length).toBeGreaterThanOrEqual(3);
    for (const secret of [
      PASSWORD,
      SETUP_TOKEN,
      session,
      typed,
      "wrong-password-value-42",
      "wrong-password-value-43",
      "CODE-abc123",
      "STATE-xyz",
      "TOK-zzz",
      jar.cookies.get("__Host-otc_as_csrf") ?? "never-set",
    ]) {
      expect(everything, secret).not.toContain(secret);
    }
    expect(everything).not.toMatch(/\$argon2id\$/);
  });
});
