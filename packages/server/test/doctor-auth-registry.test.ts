// auth.registry doctor check: a lost registry is a FAIL (every bearer is refused and, worse, a
// naive fallback would un-revoke tokens), a key file that fails the trust check is a FAIL, and the
// softer findings (requireJti off once the registry is in use; Windows key-file ACL limitation) are
// warnings that name the fix.
import { describe, expect, it } from "vitest";
import { type AuthRegistryView, authRegistryCheck } from "../src/doctor/auth-registry";

const ctx = { serverVersion: "test" };
const base: AuthRegistryView = {
  authMode: "jwt",
  state: "ok",
  dbPath: "/c/auth.db",
  keysDir: "/c/auth-keys",
  keyFileIssues: [],
  requireJti: true,
  platform: "linux",
};
const run = (over: Partial<AuthRegistryView>) => authRegistryCheck({ ...base, ...over }).run(ctx);

describe("auth.registry doctor check", () => {
  it("is ok when healthy and requireJti is on", async () => {
    expect((await run({})).status).toBe("ok");
  });

  it("is ok and quiet when auth.mode is none, whatever the registry looks like", async () => {
    expect((await run({ authMode: "none", state: "lost" })).status).toBe("ok");
  });

  it("is ok when the registry was never initialised, and does not nag about requireJti", async () => {
    const r = await run({ state: "uninitialised", requireJti: false });
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("not initialised");
  });

  it("FAILS when the registry is lost, naming auth.db, the backup recovery and the deliberate reset", async () => {
    const r = await run({ state: "lost" });
    expect(r.status).toBe("fail");
    expect(r.summary).toContain("auth.db");
    expect(r.remediation).toMatch(/restore auth\.db from backup/i);
    expect(r.remediation).toContain("/c/auth-keys");
  });

  it("names the destructive escape hatch (BOTH auth.db and the keys directory) and carries the loss detail", async () => {
    const r = await run({ state: "lost", detail: "the keys directory is unusable (symlink)" });
    expect(r.remediation).toMatch(/BOTH \/c\/auth\.db and \/c\/auth-keys/);
    expect(r.remediation).toMatch(/destructive/);
    expect(r.details).toMatchObject({ detail: "the keys directory is unusable (symlink)" });
  });

  it("FAILS on a key file that breaks the trust check, naming it", async () => {
    const r = await run({ keyFileIssues: ["k_ab.key: mode 0644 is readable by group/other"] });
    expect(r.status).toBe("fail");
    expect(r.issues?.join(" ")).toContain("k_ab.key");
  });

  it("warns to set auth.requireJti once the registry is in use", async () => {
    const r = await run({ requireJti: false });
    expect(r.status).toBe("warning");
    expect(r.remediation).toContain("auth.requireJti");
  });

  it("warns on Windows that key-file mode/owner checks are not enforced", async () => {
    const r = await run({ platform: "win32" });
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toMatch(/Windows/);
  });
});

describe("auth.registry doctor check: rotation grace visibility", () => {
  const NOW = 1_800_000_000_000;
  const key = (
    kid: string,
    state: "active" | "retiring" | "retired",
    retireAfter: number | null = null,
    alg = "HS256",
  ) => ({ kid, alg, state, retireAfter });

  it("lists each retiring key with its time remaining, in the summary and the details", async () => {
    const r = await run({
      now: NOW,
      keys: [
        key("k_new", "active"),
        key("k_old", "retiring", NOW + 2 * 3_600_000),
        key("k_older", "retiring", NOW + 90_000, "ES256"),
      ],
    });
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("2 keys retiring");
    expect(r.summary).toContain("k_old: 2.0h left");
    expect(r.summary).toContain("k_older: 2m left");
    expect(r.details).toMatchObject({
      activeKeys: ["k_new"],
      retiringKeys: ["k_old (HS256): 2.0h left", "k_older (ES256): 2m left"],
    });
  });

  it("does not list a window that has already elapsed as retiring", async () => {
    const r = await run({
      now: NOW,
      keys: [key("k_new", "active"), key("k_old", "retiring", NOW - 1)],
    });
    expect(r.summary).not.toContain("retiring");
    expect(r.details).toMatchObject({ retiringKeys: [] });
  });

  it("warns when a retiring key still has more than a day of grace left", async () => {
    const r = await run({
      now: NOW,
      keys: [key("k_new", "active"), key("k_old", "retiring", NOW + 3 * 86_400_000)],
    });
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toMatch(/k_old.*3\.0d of grace left/);
    expect(r.remediation).toMatch(/shorter --grace/);
  });

  it("does not warn at exactly one day left", async () => {
    const r = await run({
      now: NOW,
      keys: [key("k_new", "active"), key("k_old", "retiring", NOW + 86_400_000)],
    });
    expect(r.status).toBe("ok");
  });

  it("warns when auth.rotationGraceSeconds is unusually long", async () => {
    const r = await run({
      now: NOW,
      keys: [key("k_new", "active")],
      rotationGraceSeconds: 604_800,
    });
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toMatch(/rotationGraceSeconds is 7\.0d/);
    expect(
      (await run({ now: NOW, keys: [key("k_new", "active")], rotationGraceSeconds: 3600 })).status,
    ).toBe("ok");
  });

  it("says auth.jwtSecret can be removed once the config key is retired (and what removal costs)", async () => {
    const r = await run({
      now: NOW,
      jwtSecretConfigured: true,
      keys: [key("config", "retired", NOW - 10), key("k_new", "active")],
    });
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toMatch(/auth\.jwtSecret is still set.*can be removed/);
    expect(r.issues?.join(" ")).toMatch(/elicit/);
  });

  it("also treats an elapsed config window as retired, and stays quiet while it is live", async () => {
    const elapsed = await run({
      now: NOW,
      jwtSecretConfigured: true,
      keys: [key("config", "retiring", NOW - 1), key("k_new", "active")],
    });
    expect(elapsed.issues?.join(" ")).toMatch(/can be removed/);
    const live = await run({
      now: NOW,
      jwtSecretConfigured: true,
      keys: [key("config", "retiring", NOW + 60_000), key("k_new", "active")],
    });
    expect(live.status).toBe("ok");
    const removed = await run({
      now: NOW,
      jwtSecretConfigured: false,
      keys: [key("config", "retired", NOW - 10), key("k_new", "active")],
    });
    expect(removed.status).toBe("ok");
  });

  it("warns when the registry has keys but none is active", async () => {
    const r = await run({ now: NOW, keys: [key("config", "retired", NOW - 10)] });
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toMatch(/no active signing key/);
  });

  it("FAILS when there is no signing key anywhere: no secret, no JWKS, uninitialised registry", async () => {
    const r = await run({
      state: "uninitialised",
      jwtSecretConfigured: false,
      jwksConfigured: false,
    });
    expect(r.status).toBe("fail");
    expect(r.remediation).toMatch(/auth rotate-key/);
    expect(
      (await run({ state: "uninitialised", jwtSecretConfigured: true, jwksConfigured: false }))
        .status,
    ).toBe("ok");
    expect(
      (await run({ state: "uninitialised", jwtSecretConfigured: false, jwksConfigured: true }))
        .status,
    ).toBe("ok");
  });
});
