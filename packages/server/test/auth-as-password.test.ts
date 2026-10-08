// Operator password hashing for the bundled authorization server (design v2 section 4.11.4), slice
// S4: Argon2id through `node:crypto.argon2` at the OWASP minimum parameters, stored as a PHC string,
// with a refusal on the Node releases (24.0 to 24.6) that predate `crypto.argon2`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mod = () => import("../src/auth/as-password");

const PW = "correct horse battery staple";

describe("Argon2id parameters", () => {
  it("are the OWASP minimum: m = 19 MiB, t = 2, p = 1, 16-byte salt, 32-byte tag", async () => {
    const { ARGON2_PARAMS } = await mod();
    expect(ARGON2_PARAMS).toEqual({
      memory: 19456,
      passes: 2,
      parallelism: 1,
      saltLength: 16,
      tagLength: 32,
    });
  });

  it("hash to a PHC string that carries those parameters, a fresh salt each time", async () => {
    const { hashPassword } = await mod();
    const a = await hashPassword(PW);
    const b = await hashPassword(PW);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(a).not.toBe(b);
  });

  it("verify the right password and nothing else", async () => {
    const { hashPassword, verifyPassword } = await mod();
    const phc = await hashPassword(PW);
    expect(await verifyPassword(PW, phc)).toBe(true);
    expect(await verifyPassword(`${PW}x`, phc)).toBe(false);
    expect(await verifyPassword("", phc)).toBe(false);
  });

  it("verify under the parameters the hash itself records, so raised parameters can roll out", async () => {
    const { ARGON2_PARAMS, hashPassword, needsRehash, verifyPassword } = await mod();
    const weak = await hashPassword(PW, { ...ARGON2_PARAMS, memory: 8192, passes: 1 });
    expect(weak).toContain("m=8192,t=1,p=1");
    expect(await verifyPassword(PW, weak)).toBe(true);
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash(await hashPassword(PW))).toBe(false);
  });

  it("refuse a malformed or foreign hash instead of throwing", async () => {
    const { verifyPassword } = await mod();
    for (const bad of [
      "",
      "plain",
      "$argon2i$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "$argon2id$v=19$m=0,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "$argon2id$v=19$m=999999999,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "$argon2id$v=19$m=19456,t=2,p=1$short$short",
    ]) {
      expect(await verifyPassword(PW, bad)).toBe(false);
    }
  });
});

describe("password policy", () => {
  it("requires at least 12 characters and bounds the length", async () => {
    const { passwordProblem } = await mod();
    expect(passwordProblem("a".repeat(11))).toMatch(/12/);
    expect(passwordProblem("a".repeat(12))).toBeUndefined();
    expect(passwordProblem("a".repeat(1025))).toMatch(/1024/);
    expect(passwordProblem("a".repeat(1024))).toBeUndefined();
  });
});

describe("runtime without crypto.argon2", () => {
  it("is refused for Node 24.0 to 24.6, naming Node 24.7", async () => {
    const { argon2Unsupported } = await mod();
    for (const version of ["24.0.0", "24.3.1", "24.6.0", "22.20.0"]) {
      expect(argon2Unsupported({ version, hasArgon2: false })).toMatch(/Node 24\.7/);
    }
  });

  it("is accepted from Node 24.7", async () => {
    const { argon2Unsupported } = await mod();
    for (const version of ["24.7.0", "24.13.2", "26.10.0"]) {
      expect(argon2Unsupported({ version, hasArgon2: true })).toBeUndefined();
    }
  });

  it("is refused when the function is missing whatever the version says", async () => {
    const { argon2Unsupported } = await mod();
    expect(argon2Unsupported({ version: "26.0.0", hasArgon2: false })).toMatch(/crypto\.argon2/);
  });

  it("refuses a Node older than 24.7 even if the function is there, and accepts 24.7 and later", async () => {
    const { argon2Unsupported } = await mod();
    expect(argon2Unsupported({ version: "24.6.9", hasArgon2: true })).toMatch(/24\.7/);
    expect(argon2Unsupported({ version: "22.12.0", hasArgon2: true })).toMatch(/24\.7/);
    for (const version of ["24.7.0", "24.10.1", "25.0.0"]) {
      expect(argon2Unsupported({ version, hasArgon2: true }), version).toBeUndefined();
    }
  });

  it("assertArgon2Runtime throws that message, and passes on the real runtime", async () => {
    const { assertArgon2Runtime } = await mod();
    expect(() => assertArgon2Runtime({ version: "24.6.0", hasArgon2: false })).toThrow(/24\.7/);
    expect(() => assertArgon2Runtime()).not.toThrow();
  });

  it("does not import the named export, which would fail to LINK on a Node without it", () => {
    const src = readFileSync(new URL("../src/auth/as-password.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/import\s*\{[^}]*\bargon2\b[^}]*\}\s*from\s*["']node:crypto["']/);
  });
});

describe("constantTimeEqual", () => {
  it("compares equal strings true and anything else false, without throwing on length", async () => {
    const { constantTimeEqual } = await mod();
    expect(constantTimeEqual("s3cret-token", "s3cret-token")).toBe(true);
    expect(constantTimeEqual("s3cret-token", "s3cret-tokeN")).toBe(false);
    expect(constantTimeEqual("s3cret-token", "s3cret")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("is built on timingSafeEqual over fixed-length digests, not on ===", () => {
    const src = readFileSync(new URL("../src/auth/as-password.ts", import.meta.url), "utf8");
    expect(src).toContain("timingSafeEqual");
  });
});
