// THE-520: every auth failure used to collapse into one opaque string, so an operator could not
// tell a max-age rejection from a real expiry — which hid a 5-day outage where long-lived service
// tokens were killed by the 24h `tokenTtlSeconds` cap while their own `exp` was a year out.
// Rejections now carry a typed reason for logs/metrics. The CLIENT response stays undifferentiated:
// telling an unauthenticated caller *why* their token failed is an oracle.
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { AuthRejection, verifyJwt } from "../src/auth/jwt";

const secret = "x".repeat(32);
const key = new TextEncoder().encode(secret);

function mint(
  claims: Record<string, unknown>,
  set: (s: SignJWT) => SignJWT = (s) => s,
): Promise<string> {
  return set(new SignJWT(claims).setProtectedHeader({ alg: "HS256" })).sign(key);
}

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    throw new Error("expected a rejection, got success");
  } catch (e) {
    if (e instanceof AuthRejection) return e.reason;
    throw e;
  }
}

describe("THE-520 typed auth rejection reasons", () => {
  it("distinguishes max-age from expiry — the case that hid the outage", async () => {
    const hourOldIat = Math.floor(Date.now() / 1000) - 3600;
    const token = await mint({ sub: "svc" }, (s) =>
      s.setIssuedAt(hourOldIat).setExpirationTime("365d"),
    );

    expect(await reasonOf(verifyJwt(token, secret, { maxAgeSeconds: 60 }))).toBe("token_max_age");
  });

  it("flags that exp is still in the future on a max-age rejection", async () => {
    // This combination — aged out but not expired — means the operator minted a long-lived token
    // under a short tokenTtlSeconds. It is the single most useful signal in the whole ticket.
    const hourOldIat = Math.floor(Date.now() / 1000) - 3600;
    const token = await mint({ sub: "svc" }, (s) =>
      s.setIssuedAt(hourOldIat).setExpirationTime("365d"),
    );

    try {
      await verifyJwt(token, secret, { maxAgeSeconds: 60 });
      throw new Error("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthRejection);
      expect((e as AuthRejection).expStillFuture).toBe(true);
    }
  });

  it("reports a genuinely elapsed exp as token_expired, not max-age", async () => {
    const token = await mint({ sub: "alice" }, (s) => s.setExpirationTime("-1s"));

    expect(await reasonOf(verifyJwt(token, secret))).toBe("token_expired");
  });

  it("reports a bad signature distinctly", async () => {
    const token = await mint({ sub: "alice" }, (s) => s.setExpirationTime("5m"));

    expect(await reasonOf(verifyJwt(token, "y".repeat(32)))).toBe("bad_signature");
  });

  it("reports a missing required claim distinctly", async () => {
    const token = await mint({ sub: "alice" }); // no exp

    expect(await reasonOf(verifyJwt(token, secret))).toBe("missing_claim");
  });

  it("reports an audience mismatch distinctly (THE-456 path)", async () => {
    const token = await mint({ sub: "alice" }, (s) =>
      s.setExpirationTime("5m").setAudience("https://other.example"),
    );

    expect(await reasonOf(verifyJwt(token, secret, { audience: "https://me.example" }))).toBe(
      "audience_mismatch",
    );
  });

  it("reports an issuer mismatch distinctly", async () => {
    const token = await mint({ sub: "alice" }, (s) =>
      s.setExpirationTime("5m").setIssuer("https://evil.example"),
    );

    expect(await reasonOf(verifyJwt(token, secret, { issuer: "https://good.example" }))).toBe(
      "issuer_mismatch",
    );
  });

  it("carries the caller when the token decodes, so a log line can name it", async () => {
    const hourOldIat = Math.floor(Date.now() / 1000) - 3600;
    const token = await mint({ sub: "cave-agents" }, (s) =>
      s.setIssuedAt(hourOldIat).setExpirationTime("365d"),
    );

    try {
      await verifyJwt(token, secret, { maxAgeSeconds: 60 });
      throw new Error("expected rejection");
    } catch (e) {
      expect((e as AuthRejection).caller).toBe("cave-agents");
    }
  });

  it("still rejects — a typed reason must never turn a failure into a pass", async () => {
    const token = await mint({ sub: "alice" }, (s) => s.setExpirationTime("-1s"));

    await expect(verifyJwt(token, secret)).rejects.toBeInstanceOf(AuthRejection);
  });
});
