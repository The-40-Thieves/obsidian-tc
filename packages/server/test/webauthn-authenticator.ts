// A software WebAuthn authenticator for the passkey suites (slice S10): it builds the same bytes a
// platform authenticator would (attestation objects, authenticator data, clientDataJSON, ES256
// signatures), so the real verification code runs against real ceremony shapes. Every knob a
// refusal test needs is an option: the attestation format, the counter, the rpID it signs for, the
// origin it reports, whether the user was verified.
import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

function head(major: number, n: number): number[] {
  const m = major << 5;
  if (n < 24) return [m | n];
  if (n < 0x100) return [m | 24, n];
  if (n < 0x10000) return [m | 25, n >> 8, n & 0xff];
  return [m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** The subset of CBOR a WebAuthn ceremony uses: integers, text, byte strings, arrays and maps. */
export function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return Buffer.from(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    return Buffer.concat([Buffer.from(head(3, b.length)), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([Buffer.from(head(2, v.length)), v]);
  if (Array.isArray(v)) return Buffer.concat([Buffer.from(head(4, v.length)), ...v.map(cbor)]);
  const parts: Buffer[] = [Buffer.from(head(5, v.size))];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return Buffer.concat(parts);
}

const sha256 = (b: Buffer | string): Buffer => createHash("sha256").update(b).digest();
const b64u = (b: Buffer | Uint8Array): string => Buffer.from(b).toString("base64url");

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_BE = 0x08;
export const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export interface CreationOptions {
  challenge: string;
  rp: { id?: string };
  user: { id: string };
  authenticatorSelection?: { residentKey?: string; userVerification?: string };
  attestation?: string;
  excludeCredentials?: Array<{ id: string }>;
}
export interface RequestOptions {
  challenge: string;
  rpId?: string;
  userVerification?: string;
  allowCredentials?: unknown[];
}

export interface CeremonyKnobs {
  /** The rpID the authenticator signs for (default: the one it was created for). */
  rpID?: string;
  /** The origin the browser reports in clientDataJSON. */
  origin?: string;
  /** Leave the user-verified flag off. */
  noUserVerification?: boolean;
  /** Extra authenticator-data flags (backup eligible, backed up). */
  flags?: number;
}

export class VirtualAuthenticator {
  readonly credentialId: Buffer;
  /** The counter value the next assertion reports; `"constant-zero"` models a synced passkey. */
  counter: number | "constant-zero" = 0;
  private readonly privateKey: KeyObject;
  private readonly publicKeyCbor: Buffer;
  private userHandle: Buffer = Buffer.alloc(0);

  constructor(
    readonly origin: string,
    readonly rpID: string,
  ) {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.publicKeyCbor = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x as string, "base64url")],
        [-3, Buffer.from(jwk.y as string, "base64url")],
      ]),
    );
    this.credentialId = Buffer.from(sha256(this.publicKeyCbor)).subarray(0, 16);
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  private authData(rpID: string, flags: number, counter: number, attested: boolean): Buffer {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter >>> 0);
    const base = [sha256(rpID), Buffer.from([flags | (attested ? FLAG_AT : 0)]), c];
    if (!attested) return Buffer.concat(base);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([...base, Buffer.alloc(16), len, this.credentialId, this.publicKeyCbor]);
  }

  private sign(data: Buffer): Buffer {
    return createSign("SHA256").update(data).sign(this.privateKey);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** Answer `navigator.credentials.create()`. `fmt: "packed"` produces a self-attestation. */
  register(options: CreationOptions, knobs: CeremonyKnobs & { fmt?: "none" | "packed" } = {}) {
    this.userHandle = Buffer.from(options.user.id, "base64url");
    const rpID = knobs.rpID ?? this.rpID;
    const flags = FLAG_UP | (knobs.noUserVerification ? 0 : FLAG_UV) | (knobs.flags ?? 0);
    const authData = this.authData(rpID, flags, 0, true);
    const clientDataJSON = this.clientData(
      "webauthn.create",
      options.challenge,
      knobs.origin ?? this.origin,
    );
    const attStmt =
      knobs.fmt === "packed"
        ? new Map<Cbor, Cbor>([
            ["alg", -7],
            ["sig", this.sign(Buffer.concat([authData, sha256(clientDataJSON)]))],
          ])
        : new Map<Cbor, Cbor>();
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", knobs.fmt ?? "none"],
        ["attStmt", attStmt],
        ["authData", authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
    };
  }

  /** Answer `navigator.credentials.get()`; each assertion advances the counter unless it is constant 0. */
  assert(options: RequestOptions, knobs: CeremonyKnobs & { userHandle?: Buffer | null } = {}) {
    const rpID = knobs.rpID ?? this.rpID;
    if (this.counter !== "constant-zero") this.counter += 1;
    const counter = this.counter === "constant-zero" ? 0 : this.counter;
    const flags = FLAG_UP | (knobs.noUserVerification ? 0 : FLAG_UV) | (knobs.flags ?? 0);
    const authData = this.authData(rpID, flags, counter, false);
    const clientDataJSON = this.clientData(
      "webauthn.get",
      options.challenge,
      knobs.origin ?? this.origin,
    );
    const signature = this.sign(Buffer.concat([authData, sha256(clientDataJSON)]));
    const handle = knobs.userHandle === undefined ? this.userHandle : knobs.userHandle;
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        ...(handle === null ? {} : { userHandle: b64u(handle) }),
      },
    };
  }
}
