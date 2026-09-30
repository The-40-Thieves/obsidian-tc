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
