// The WebAuthn ceremonies of the bundled authorization server's passkeys (design v2 section 4.11),
// as thin policy over `@simplewebauthn/server`: discoverable credentials and user verification
// required, attestation `none` ONLY, `rpID` the issuer's host and the expected origin the issuer's
// origin. The library's advisories all sit in attestation-certificate handling; refusing every
// other format BEFORE verification keeps that code unreachable from the wire.
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  decodeAttestationObject,
  decodeClientDataJSON,
  isoBase64URL,
} from "@simplewebauthn/server/helpers";
import { z } from "zod";
import type { StoredCredential } from "./as-passkey-store";

export interface RelyingParty {
  /** The issuer's host. A hostname change orphans every credential (see `auth as reset-credentials`). */
  rpID: string;
  /** The issuer's origin: the only origin a ceremony may run on. */
  origin: string;
  name: string;
}

export function relyingPartyOf(issuer: string): RelyingParty {
  const url = new URL(issuer);
  return { rpID: url.hostname, origin: url.origin, name: "obsidian-tc" };
}

export type PasskeyRefusal =
  | "attestation_format"
  | "malformed"
  | "not_verified"
  | "cloned_or_replayed"
  | "wrong_account";

/** A ceremony the server refuses. The reason is for the log; the browser is told only "refused". */
export class PasskeyRefused extends Error {
  constructor(
    readonly reason: PasskeyRefusal,
    detail?: string,
  ) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
    this.name = "PasskeyRefused";
  }
}

const b64 = z.string().min(1).max(8192);
const clientExtensionResults = z.record(z.string(), z.unknown()).default({});

/** The body of a registration answer, as `PublicKeyCredential.toJSON()` produces it. */
const RegistrationBody = z.object({
  id: b64,
  rawId: b64,
  type: z.literal("public-key"),
  clientExtensionResults,
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  response: z.object({
    clientDataJSON: b64,
    attestationObject: b64,
    authenticatorData: b64.optional(),
    transports: z.array(z.string().max(32)).max(8).optional(),
    publicKey: b64.optional(),
    publicKeyAlgorithm: z.number().int().optional(),
  }),
});

/** The body of an authentication answer. */
const AuthenticationBody = z.object({
  id: b64,
  rawId: b64,
  type: z.literal("public-key"),
  clientExtensionResults,
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  response: z.object({
    clientDataJSON: b64,
    authenticatorData: b64,
    signature: b64,
    userHandle: b64.optional(),
  }),
});

export function parseRegistrationBody(raw: unknown): RegistrationResponseJSON | undefined {
  const r = RegistrationBody.safeParse(raw);
  return r.success ? (r.data as RegistrationResponseJSON) : undefined;
}

export function parseAuthenticationBody(raw: unknown): AuthenticationResponseJSON | undefined {
  const r = AuthenticationBody.safeParse(raw);
  return r.success ? (r.data as AuthenticationResponseJSON) : undefined;
}

/** The challenge the authenticator signed, read from the answer's clientDataJSON (undefined if unreadable). */
export function challengeOf(response: {
  response: { clientDataJSON: string };
}): string | undefined {
  try {
    const challenge = decodeClientDataJSON(response.response.clientDataJSON).challenge;
    return typeof challenge === "string" && challenge !== "" ? challenge : undefined;
  } catch {
    return undefined;
  }
}

export function registrationOptions(
  rp: RelyingParty,
  user: { sub: string; username: string },
  existing: readonly StoredCredential[],
) {
  return generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.rpID,
    userName: user.username,
    userID: new TextEncoder().encode(user.sub),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
}

export interface RegisteredCredential {
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: string[];
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
}

/**
 * Verify a registration. Attestation `none` is the only format accepted, and it is checked on the raw
 * attestation object BEFORE the library sees it: a `packed`, `tpm`, `android-*`, `apple` or `fido-u2f`
 * statement is refused without entering any certificate-chain code.
 */
export async function verifyRegistration(
  rp: RelyingParty,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
): Promise<RegisteredCredential> {
  let fmt: string;
  try {
    const attestation = decodeAttestationObject(
      isoBase64URL.toBuffer(response.response.attestationObject),
    );
    fmt = attestation.get("fmt");
  } catch {
    throw new PasskeyRefused("malformed", "attestation object");
  }
  if (fmt !== "none") throw new PasskeyRefused("attestation_format", String(fmt));
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserPresence: true,
      requireUserVerification: true,
    });
  } catch (e) {
    throw new PasskeyRefused("not_verified", e instanceof Error ? e.message : "registration");
  }
  const info = verified.registrationInfo;
  if (!verified.verified || info === undefined || info.fmt !== "none") {
    throw new PasskeyRefused("not_verified", "registration");
  }
  return {
    credentialId: info.credential.id,
    publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
    signCount: info.credential.counter,
    transports: info.credential.transports ?? response.response.transports ?? [],
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
  };
}

/** Options for a username-less login: no `allowCredentials`, so the authenticator offers its passkeys. */
export function authenticationOptions(rp: RelyingParty) {
  return generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "required" });
}

const userHandleOf = (b64url: string): string => Buffer.from(b64url, "base64url").toString("utf8");

/**
 * Verify an assertion against the stored credential. The library enforces the rpID hash, origin,
 * challenge, user verification and signature, and refuses a counter that is not greater than the
 * stored one unless both are 0 (a synced passkey reports a constant 0). The user handle, when the
 * authenticator returns one, must name the operator the credential belongs to.
 */
export async function verifyAssertion(
  rp: RelyingParty,
  response: AuthenticationResponseJSON,
  stored: StoredCredential,
  expectedChallenge: string,
): Promise<{ newCounter: number; backedUp: boolean }> {
  const handle = response.response.userHandle;
  if (handle !== undefined && userHandleOf(handle) !== stored.sub) {
    throw new PasskeyRefused("wrong_account");
  }
  let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      credential: {
        id: stored.credentialId,
        publicKey: isoBase64URL.toBuffer(stored.publicKey),
        counter: stored.signCount,
        transports: stored.transports as never,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "assertion";
    throw new PasskeyRefused(
      /counter/i.test(message) ? "cloned_or_replayed" : "not_verified",
      message,
    );
  }
  if (!verified.verified) throw new PasskeyRefused("not_verified", "assertion");
  return {
    newCounter: verified.authenticationInfo.newCounter,
    backedUp: verified.authenticationInfo.credentialBackedUp,
  };
}
