// THE-583: the HITL request-state codec that replaces the single-use elicit token.
//
// `stateAuthorizes` is the whole security contract of the new shape — a verified state is a
// capability, and the only thing stopping one approval from authorizing a different call is that
// every field is compared. Each field therefore gets its own test: a single `toBe(false)` on a
// wholesale-different state would still pass if three of the four comparisons were dropped.
import { describe, expect, it } from "vitest";
import {
  createElicitCodec,
  deriveRequestStateKey,
  type ElicitRequestState,
  stateAuthorizes,
} from "../src/elicit-request-state";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const CALL = { tool: "write_note", argsHash: "a1b2", vaultId: "main", caller: "agent-1" };
const STATE: ElicitRequestState = { ...CALL };

describe("deriveRequestStateKey", () => {
  it("produces a 32-byte key even from a short secret", () => {
    // The codec throws RangeError below 32 bytes, so a deployment with a short jwtSecret would
    // fail to boot rather than degrade — worth pinning.
    expect(deriveRequestStateKey("short").length).toBe(32);
  });

  it("is domain-separated from the JWT secret itself", () => {
    // Reusing one secret verbatim for two primitives means a flaw in either touches both.
    const key = Buffer.from(deriveRequestStateKey(SECRET)).toString("hex");
    expect(key).not.toContain(Buffer.from(SECRET).toString("hex"));
  });

  it("changes when the secret rotates, so rotation invalidates outstanding confirmations", () => {
    expect(Buffer.from(deriveRequestStateKey(SECRET)).toString("hex")).not.toBe(
      Buffer.from(deriveRequestStateKey(`${SECRET}x`)).toString("hex"),
    );
  });
});

describe("the codec round-trips and authenticates", () => {
  it("mints a state that verifies back to the same payload", async () => {
    const codec = createElicitCodec(SECRET, 300);
    const minted = await codec.mint(STATE);
    expect(typeof minted).toBe("string");
    await expect(codec.verify(minted)).resolves.toMatchObject(STATE);
  });

  it("rejects a tampered state", async () => {
    const codec = createElicitCodec(SECRET, 300);
    const minted = await codec.mint(STATE);
    // Flip a character in the payload; the HMAC must not survive it.
    const tampered = `${minted.slice(0, -4)}AAAA`;
    await expect(codec.verify(tampered)).rejects.toThrow();
  });

  it("rejects a state minted under a DIFFERENT secret", async () => {
    // The cross-deployment case: a confirmation from one server must not spend on another.
    const minted = await createElicitCodec(SECRET, 300).mint(STATE);
    await expect(createElicitCodec(`${SECRET}-other`, 300).verify(minted)).rejects.toThrow();
  });

  it("rejects garbage outright rather than returning a partial payload", async () => {
    await expect(createElicitCodec(SECRET, 300).verify("not-a-state")).rejects.toThrow();
  });
});

describe("stateAuthorizes — one approval authorizes exactly one call", () => {
  it("accepts the call it was issued for", () => {
    expect(stateAuthorizes(STATE, CALL)).toBe(true);
  });

  it("refuses a different TOOL", () => {
    // Approving a note write must not authorize a delete.
    expect(stateAuthorizes(STATE, { ...CALL, tool: "delete_note" })).toBe(false);
  });

  it("refuses different ARGUMENTS", () => {
    // The argsHash binding is what stops an approved write of one file authorizing another.
    expect(stateAuthorizes(STATE, { ...CALL, argsHash: "deadbeef" })).toBe(false);
  });

  it("refuses a different VAULT", () => {
    // Cross-vault isolation is enforced everywhere else (THE-267); a confirmation must not be the
    // hole in it.
    expect(stateAuthorizes(STATE, { ...CALL, vaultId: "agents" })).toBe(false);
  });

  it("refuses a different CALLER", () => {
    expect(stateAuthorizes(STATE, { ...CALL, caller: "agent-2" })).toBe(false);
  });

  it("treats a null caller as its own identity, not a wildcard", () => {
    // An anonymous confirmation must not spend on an identified caller's behalf, or vice versa.
    const anon: ElicitRequestState = { ...STATE, caller: null };
    expect(stateAuthorizes(anon, { ...CALL, caller: null })).toBe(true);
    expect(stateAuthorizes(anon, CALL)).toBe(false);
    expect(stateAuthorizes(STATE, { ...CALL, caller: null })).toBe(false);
  });
});

describe("the documented REPLAY trade (THE-583)", () => {
  it("verifies the SAME state repeatedly — it is authenticated, not consumed", async () => {
    // This asserts a known, accepted weakness rather than a desired property, so that it is
    // impossible to believe the old single-use semantics survived the migration. The elicit_tokens
    // table this replaced was one-shot (`UPDATE … WHERE consumed_at IS NULL`).
    //
    // If one-time semantics come back (a consumed-nonce table keyed on the state), THIS TEST SHOULD
    // FAIL — that failure is the signal the trade was reversed, and the test should then be
    // inverted rather than deleted.
    const codec = createElicitCodec(SECRET, 300);
    const minted = await codec.mint(STATE);
    await expect(codec.verify(minted)).resolves.toMatchObject(STATE);
    await expect(codec.verify(minted)).resolves.toMatchObject(STATE);
    await expect(codec.verify(minted)).resolves.toMatchObject(STATE);
  });
});
