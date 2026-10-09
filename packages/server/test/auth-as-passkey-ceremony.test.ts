// The WebAuthn ceremonies behind the operator's passkeys (design v2 section 4.11, slice S10): what the
// server refuses, driven by a software authenticator that produces real attestation objects and
// assertions. The RED cases are the spec's: a non-`none` attestation format, a cloned authenticator
// (stored counter non-zero, new one not greater), and a credential registered for another rpID.
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimOperator,
  createSession,
  lookupSession,
  type SessionGuard,
} from "../src/auth/as-operator-store";
import {
  authenticationOptions,
  challengeOf,
  PasskeyRefused,
  parseAuthenticationBody,
  parseRegistrationBody,
  registrationOptions,
  relyingPartyOf,
  verifyAssertion,
  verifyRegistration,
} from "../src/auth/as-passkey";
import {
  addCredential,
  finalizePasskeyLogin,
  findCredential,
  MAX_PENDING_LOGIN_CHALLENGES,
  type StoredCredential,
  storeChallenge,
  takeChallenge,
} from "../src/auth/as-passkey-store";
import { gcOauthDb } from "../src/auth/oauth-db";
import { provisionOauthDb } from "../src/db/provision";
import { openMemoryDb } from "./helpers";
import { FLAG_BE, FLAG_BS, VirtualAuthenticator } from "./webauthn-authenticator";

const ISSUER = "https://vault.example.com";
const rp = relyingPartyOf(ISSUER);
const T0 = 1_800_000_000_000;
const USER = { sub: "usr_test", username: "operator" };

async function enroll(
  auth: VirtualAuthenticator,
  knobs: Parameters<VirtualAuthenticator["register"]>[1] = {},
) {
  const options = await registrationOptions(rp, USER, []);
  const response = parseRegistrationBody(auth.register(options, knobs));
  if (response === undefined) throw new Error("virtual authenticator produced a malformed body");
  return verifyRegistration(rp, response, options.challenge);
}

const stored = (
  c: Awaited<ReturnType<typeof enroll>>,
  signCount = c.signCount,
): StoredCredential => ({
  ...c,
  sub: USER.sub,
  signCount,
  createdAt: T0,
  lastUsedAt: null,
});

async function assertWith(
  auth: VirtualAuthenticator,
  credential: StoredCredential,
  knobs: Parameters<VirtualAuthenticator["assert"]>[1] = {},
) {
  const options = await authenticationOptions(rp);
  const response = parseAuthenticationBody(auth.assert(options, knobs));
  if (response === undefined) throw new Error("virtual authenticator produced a malformed body");
  return verifyAssertion(rp, response, credential, options.challenge);
}

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof PasskeyRefused) return e.reason;
    throw e;
  }
  return "accepted";
};

describe("relying party", () => {
  it("is the issuer's host and origin", () => {
    expect(relyingPartyOf("https://vault.example.com")).toMatchObject({
      rpID: "vault.example.com",
      origin: "https://vault.example.com",
    });
    expect(relyingPartyOf("http://localhost:8787")).toMatchObject({
      rpID: "localhost",
      origin: "http://localhost:8787",
    });
  });
});

describe("registration", () => {
  it("asks for a discoverable, user-verified credential with attestation none", async () => {
    const o = await registrationOptions(rp, USER, []);
    expect(o.attestation).toBe("none");
    expect(o.authenticatorSelection).toMatchObject({
      residentKey: "required",
      userVerification: "required",
    });
    expect(o.rp.id).toBe("vault.example.com");
    expect(Buffer.from(o.user.id, "base64url").toString()).toBe(USER.sub);
  });

  it("accepts a `none` attestation and returns the credential to store", async () => {
    const auth = new VirtualAuthenticator(ISSUER, rp.rpID);
    const c = await enroll(auth);
    expect(c.credentialId).toBe(auth.id);
    expect(c.signCount).toBe(0);
    expect(c.deviceType).toBe("singleDevice");
    expect(c.backedUp).toBe(false);
    expect(c.publicKey.length).toBeGreaterThan(40);
  });

  it("records a synced (backup-eligible, backed-up) passkey as multiDevice", async () => {
    const c = await enroll(new VirtualAuthenticator(ISSUER, rp.rpID), { flags: FLAG_BE | FLAG_BS });
    expect(c).toMatchObject({ deviceType: "multiDevice", backedUp: true });
  });

  it("RED: refuses a packed attestation (a format other than none)", async () => {
    const auth = new VirtualAuthenticator(ISSUER, rp.rpID);
    expect(await refusal(enroll(auth, { fmt: "packed" }))).toBe("attestation_format");
  });

  it("RED: refuses a credential registered for another rpID", async () => {
    const auth = new VirtualAuthenticator(ISSUER, rp.rpID);
    expect(await refusal(enroll(auth, { rpID: "evil.example" }))).toBe("not_verified");
  });

  it("refuses an answer from another origin", async () => {
    const auth = new VirtualAuthenticator(ISSUER, rp.rpID);
    expect(await refusal(enroll(auth, { origin: "https://evil.example" }))).toBe("not_verified");
  });

  it("refuses a registration without user verification", async () => {
    const auth = new VirtualAuthenticator(ISSUER, rp.rpID);
    expect(await refusal(enroll(auth, { noUserVerification: true }))).toBe("not_verified");
  });

  it("refuses an answer to a different challenge", async () => {
    const auth = new VirtualAuthenticator(ISSUER, rp.rpID);
    const options = await registrationOptions(rp, USER, []);
    const body = parseRegistrationBody(auth.register(options));
    if (body === undefined) throw new Error("malformed");
    expect(await refusal(verifyRegistration(rp, body, "another-challenge"))).toBe("not_verified");
  });

  it("refuses an attestation object that is not CBOR", async () => {
    const auth = new VirtualAuthenticator(ISSUER, rp.rpID);
    const options = await registrationOptions(rp, USER, []);
    const body = parseRegistrationBody(auth.register(options));
    if (body === undefined) throw new Error("malformed");
    body.response.attestationObject = Buffer.from("not cbor at all").toString("base64url");
    expect(await refusal(verifyRegistration(rp, body, options.challenge))).toBe("malformed");
  });

  it("excludes the credentials the operator already holds", async () => {
    const c = await enroll(new VirtualAuthenticator(ISSUER, rp.rpID));
    const o = await registrationOptions(rp, USER, [stored(c)]);
    expect(o.excludeCredentials?.map((x) => x.id)).toEqual([c.credentialId]);
  });
});

describe("authentication", () => {
  let auth: VirtualAuthenticator;
  let credential: StoredCredential;
  beforeEach(async () => {
    auth = new VirtualAuthenticator(ISSUER, rp.rpID);
    credential = stored(await enroll(auth));
  });

  it("offers no allowCredentials (username-less) and requires user verification", async () => {
    const o = await authenticationOptions(rp);
    expect(o.allowCredentials ?? []).toEqual([]);
    expect(o.userVerification).toBe("required");
    expect(o.rpId).toBe("vault.example.com");
  });

  it("accepts a fresh assertion and reports the new counter", async () => {
    expect(await assertWith(auth, credential)).toMatchObject({ newCounter: 1 });
  });

  it("RED: refuses a cloned authenticator whose counter did not increase", async () => {
    // Stored counter 5; a clone that last saw 2 reports 3 (lower), another that reports 5 (equal).
    credential = { ...credential, signCount: 5 };
    auth.counter = 2;
    expect(await refusal(assertWith(auth, credential))).toBe("cloned_or_replayed");
    auth.counter = 4;
    expect(await refusal(assertWith(auth, credential))).toBe("cloned_or_replayed");
    auth.counter = 5;
    expect(await assertWith(auth, credential)).toMatchObject({ newCounter: 6 });
  });

  it("RED: refuses a constant-zero counter once a non-zero one is stored", async () => {
    credential = { ...credential, signCount: 3 };
    auth.counter = "constant-zero";
    expect(await refusal(assertWith(auth, credential))).toBe("cloned_or_replayed");
  });

  it("accepts a constant-zero counter while 0 is stored (synced passkeys)", async () => {
    auth.counter = "constant-zero";
    expect(await assertWith(auth, credential)).toMatchObject({ newCounter: 0 });
    expect(await assertWith(auth, credential)).toMatchObject({ newCounter: 0 });
  });

  it("RED: a credential registered for another rpID fails authentication", async () => {
    // The stored credential is genuine; the authenticator signs for a different relying party.
    expect(await refusal(assertWith(auth, credential, { rpID: "evil.example" }))).toBe(
      "not_verified",
    );
  });

  it("refuses an assertion reported from another origin", async () => {
    expect(await refusal(assertWith(auth, credential, { origin: "https://evil.example" }))).toBe(
      "not_verified",
    );
  });

  it("refuses an assertion without user verification", async () => {
    expect(await refusal(assertWith(auth, credential, { noUserVerification: true }))).toBe(
      "not_verified",
    );
  });

  it("refuses an assertion signed by another key", async () => {
    const other = new VirtualAuthenticator(ISSUER, rp.rpID);
    const options = await authenticationOptions(rp);
    const body = parseAuthenticationBody({
      ...other.assert(options, { userHandle: null }),
      id: auth.id,
      rawId: auth.id,
    });
    if (body === undefined) throw new Error("malformed");
    expect(await refusal(verifyAssertion(rp, body, credential, options.challenge))).toBe(
      "not_verified",
    );
  });

  it("refuses a user handle that names another account", async () => {
    expect(
      await refusal(assertWith(auth, credential, { userHandle: Buffer.from("usr_someone_else") })),
    ).toBe("wrong_account");
  });
});

describe("request bodies", () => {
  it("parses what PublicKeyCredential.toJSON() produces and rejects the rest", async () => {
    const auth = new VirtualAuthenticator(ISSUER, rp.rpID);
    const options = await registrationOptions(rp, USER, []);
    const body = auth.register(options);
    expect(parseRegistrationBody(body)).toBeDefined();
    expect(challengeOf(body)).toBe(options.challenge);
    expect(parseRegistrationBody({ ...body, type: "password" })).toBeUndefined();
    expect(parseRegistrationBody({ id: "x" })).toBeUndefined();
    expect(parseRegistrationBody(null)).toBeUndefined();
    expect(parseAuthenticationBody(body)).toBeUndefined();
    expect(challengeOf({ response: { clientDataJSON: "@@@" } })).toBeUndefined();
  });
});

describe("challenge and credential store", () => {
  const db = openMemoryDb();
  provisionOauthDb(db, { version: "t" });
  let sub = "";
  let session: SessionGuard;
  beforeEach(() => {
    db.exec(
      "DELETE FROM webauthn_challenges; DELETE FROM webauthn_credentials; DELETE FROM sessions; DELETE FROM users; DELETE FROM setup_state",
    );
    const claim = claimOperator(db, { username: "operator", passwordHash: "x", now: T0 });
    if (!claim.ok) throw new Error("claim");
    sub = claim.sub;
    const live = lookupSession(db, createSession(db, sub, T0), T0);
    if (live === undefined) throw new Error("session");
    session = live;
  });

  it("a challenge answers once, for its own purpose, before it expires", () => {
    expect(storeChallenge(db, { challenge: "c1", purpose: "login", sub: null, now: T0 })).toBe(
      true,
    );
    expect(takeChallenge(db, { challenge: "c1", purpose: "register", now: T0 })).toBeUndefined();
    expect(takeChallenge(db, { challenge: "c1", purpose: "login", now: T0 + 1000 })).toEqual({
      sub: null,
    });
    expect(
      takeChallenge(db, { challenge: "c1", purpose: "login", now: T0 + 1000 }),
    ).toBeUndefined();
    storeChallenge(db, { challenge: "c2", purpose: "login", sub: null, now: T0 });
    expect(
      takeChallenge(db, { challenge: "c2", purpose: "login", now: T0 + 6 * 60_000 }),
    ).toBeUndefined();
  });

  it("the oauth.db sweep drops expired challenges and keeps live ones and every passkey", () => {
    storeChallenge(db, { challenge: "old", purpose: "login", sub: null, now: T0 });
    storeChallenge(db, { challenge: "new", purpose: "login", sub: null, now: T0 + 4 * 60_000 });
    addCredential(db, {
      credentialId: "kept",
      sub,
      publicKey: "pk",
      signCount: 0,
      transports: [],
      deviceType: "singleDevice",
      backedUp: false,
      createdAt: T0,
      session,
    });
    const counts = gcOauthDb(db, { now: T0 + 6 * 60_000, dcrUnusedDays: 90 });
    expect(counts.webauthnChallenges).toBe(1);
    expect(takeChallenge(db, { challenge: "new", purpose: "login", now: T0 + 6 * 60_000 })).toEqual(
      { sub: null },
    );
    expect(findCredential(db, "kept")).toBeDefined();
  });

  it("is bounded: past the cap no further challenge is issued until some expire", () => {
    for (let i = 0; i < MAX_PENDING_LOGIN_CHALLENGES; i++) {
      expect(storeChallenge(db, { challenge: `c${i}`, purpose: "login", sub: null, now: T0 })).toBe(
        true,
      );
    }
    expect(storeChallenge(db, { challenge: "over", purpose: "login", sub: null, now: T0 })).toBe(
      false,
    );
    expect(
      storeChallenge(db, { challenge: "later", purpose: "login", sub: null, now: T0 + 6 * 60_000 }),
    ).toBe(true);
  });

  const credential = (id: string, signCount = 0) => ({
    credentialId: id,
    sub,
    publicKey: "pk",
    signCount,
    transports: ["internal"],
    deviceType: "singleDevice" as const,
    backedUp: false,
    createdAt: T0,
    session,
  });

  it("refuses a duplicate credential id and an unknown account", () => {
    expect(addCredential(db, credential("a"))).toEqual({ ok: true });
    expect(addCredential(db, credential("a"))).toEqual({ ok: false, reason: "duplicate" });
    expect(addCredential(db, { ...credential("b"), sub: "usr_nobody" })).toEqual({
      ok: false,
      reason: "no_account",
    });
    expect(findCredential(db, "a")).toMatchObject({ transports: ["internal"], lastUsedAt: null });
  });

  it("a login moves the counter forward once: the same counter cannot win twice", () => {
    addCredential(db, credential("a", 4));
    const login = (newCounter: number) =>
      finalizePasskeyLogin(db, { credentialId: "a", sub, newCounter, backedUp: false, now: T0 });
    expect(login(5)).toBeTypeOf("string");
    expect(login(5)).toBeUndefined();
    expect(login(3)).toBeUndefined();
    expect(findCredential(db, "a")).toMatchObject({ signCount: 5, lastUsedAt: T0 });
  });

  it("a constant-zero counter logs in while 0 is stored, and stops once a counter is stored", () => {
    addCredential(db, credential("z", 0));
    const login = (newCounter: number) =>
      finalizePasskeyLogin(db, { credentialId: "z", sub, newCounter, backedUp: false, now: T0 });
    expect(login(0)).toBeTypeOf("string");
    expect(login(0)).toBeTypeOf("string");
    expect(login(2)).toBeTypeOf("string");
    expect(login(0)).toBeUndefined();
  });

  it("a login for a credential that was removed, or an account that was disabled, yields no session", () => {
    addCredential(db, credential("a"));
    db.prepare("DELETE FROM webauthn_credentials WHERE credential_id = 'a'").run();
    expect(
      finalizePasskeyLogin(db, { credentialId: "a", sub, newCounter: 1, backedUp: false, now: T0 }),
    ).toBeUndefined();
    addCredential(db, credential("b"));
    db.prepare("UPDATE users SET disabled_at = ? WHERE sub = ?").run(T0, sub);
    expect(
      finalizePasskeyLogin(db, { credentialId: "b", sub, newCounter: 1, backedUp: false, now: T0 }),
    ).toBeUndefined();
  });
});
