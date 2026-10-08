// Operator password hashing for the bundled authorization server (design v2 section 4.11.4):
// Argon2id through `node:crypto.argon2`, at the OWASP minimum parameters, stored as a PHC string so
// the parameters travel with the hash and can be raised with a rehash on login.
//
// `crypto.argon2` exists from Node 24.7 and in Bun, but `engines` admits Node 24.0 to 24.6. So the
// module is imported as a NAMESPACE and the function read from it at call time: a named import of a
// member the runtime lacks fails to LINK, which would stop the whole server on those releases
// instead of refusing only `auth.as.enabled`.
import * as nodeCrypto from "node:crypto";
import { promisify } from "node:util";

/** OWASP minimum for Argon2id: m = 19 MiB, t = 2, p = 1 (about 150 ms on the reference host). */
export const ARGON2_PARAMS = {
  memory: 19456,
  passes: 2,
  parallelism: 1,
  saltLength: 16,
  tagLength: 32,
} as const;

export type Argon2Params = { -readonly [K in keyof typeof ARGON2_PARAMS]: number };

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;

/** A PHC string from a tampered store must not be able to ask for an unbounded amount of memory. */
const MAX_VERIFY_MEMORY_KIB = 262_144;
const MAX_VERIFY_PASSES = 16;

interface Argon2Input {
  message: string;
  nonce: Buffer;
  parallelism: number;
  tagLength: number;
  memory: number;
  passes: number;
}
type Argon2Fn = (
  algorithm: "argon2id",
  params: Argon2Input,
  cb: (err: Error | null, key: Buffer) => void,
) => void;

const argon2Fn = (): Argon2Fn | undefined =>
  (nodeCrypto as unknown as { argon2?: Argon2Fn }).argon2;

export interface Argon2Runtime {
  version: string;
  hasArgon2: boolean;
}

const MIN_NODE = [24, 7, 0] as const;

const versionBelow = (version: string): boolean => {
  const parts = version.split(".").map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < 3; i++) {
    const have = Number.isFinite(parts[i]) ? (parts[i] as number) : 0;
    if (have !== MIN_NODE[i]) return have < (MIN_NODE[i] as number);
  }
  return false;
};

/** Why this runtime cannot hash passwords, or undefined when it can. */
export function argon2Unsupported(
  runtime: Argon2Runtime = {
    version: process.versions.node,
    hasArgon2: argon2Fn() !== undefined,
  },
): string | undefined {
  if (versionBelow(runtime.version)) {
    return `auth.as needs Node 24.7 or later for crypto.argon2 (this is Node ${runtime.version}): upgrade Node, or set auth.as.enabled to false`;
  }
  if (!runtime.hasArgon2) {
    return "auth.as needs crypto.argon2 (Node 24.7 or later, or Bun), which this runtime does not provide: set auth.as.enabled to false";
  }
  return undefined;
}

export function assertArgon2Runtime(runtime?: Argon2Runtime): void {
  const why = argon2Unsupported(runtime);
  if (why !== undefined) throw new Error(why);
}

const derive = (message: string, nonce: Buffer, p: Argon2Params): Promise<Buffer> => {
  const fn = argon2Fn();
  if (fn === undefined) return Promise.reject(new Error(argon2Unsupported() ?? "no crypto.argon2"));
  return promisify(fn)("argon2id", {
    message,
    nonce,
    parallelism: p.parallelism,
    tagLength: p.tagLength,
    memory: p.memory,
    passes: p.passes,
  });
};

const b64 = (b: Buffer): string => b.toString("base64").replace(/=+$/, "");

/** Hash a password to a PHC string, `$argon2id$v=19$m=…,t=…,p=…$<salt>$<tag>`, with a fresh salt. */
export async function hashPassword(
  password: string,
  params: Argon2Params = ARGON2_PARAMS,
): Promise<string> {
  const salt = nodeCrypto.randomBytes(params.saltLength);
  const tag = await derive(password, salt, params);
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(tag)}`;
}

const PHC =
  /^\$argon2id\$v=19\$m=(\d{1,9}),t=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]{11,86})\$([A-Za-z0-9+/]{22,172})$/;

interface Parsed {
  params: Argon2Params;
  salt: Buffer;
  tag: Buffer;
}

function parsePhc(phc: string): Parsed | undefined {
  const m = PHC.exec(phc);
  if (m === null) return undefined;
  const memory = Number(m[1]);
  const passes = Number(m[2]);
  const parallelism = Number(m[3]);
  if (
    memory < 8 * parallelism ||
    memory > MAX_VERIFY_MEMORY_KIB ||
    passes < 1 ||
    passes > MAX_VERIFY_PASSES ||
    parallelism < 1 ||
    parallelism > 16
  ) {
    return undefined;
  }
  const salt = Buffer.from(m[4] as string, "base64");
  const tag = Buffer.from(m[5] as string, "base64");
  if (salt.length < 8 || tag.length < 16) return undefined;
  return {
    params: {
      memory,
      passes,
      parallelism,
      saltLength: salt.length,
      tagLength: tag.length,
    },
    salt,
    tag,
  };
}

/** Verify under the parameters the stored hash records. False for a malformed or foreign hash. */
export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const parsed = parsePhc(phc);
  if (parsed === undefined) return false;
  const tag = await derive(password, parsed.salt, parsed.params);
  return tag.length === parsed.tag.length && nodeCrypto.timingSafeEqual(tag, parsed.tag);
}

/** True when the stored hash was made under weaker parameters than the current minimum. */
export function needsRehash(phc: string): boolean {
  const parsed = parsePhc(phc);
  if (parsed === undefined) return true;
  const p = parsed.params;
  return (
    p.memory < ARGON2_PARAMS.memory ||
    p.passes < ARGON2_PARAMS.passes ||
    p.parallelism !== ARGON2_PARAMS.parallelism ||
    p.tagLength < ARGON2_PARAMS.tagLength
  );
}

/** The reason a candidate password is refused, or undefined when it is acceptable. */
export function passwordProblem(password: string): string | undefined {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `the password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `the password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  return undefined;
}

/**
 * Compare two secrets in constant time. Both sides are hashed to a fixed length first, so the
 * comparison neither throws on a length difference nor leaks the expected length through timing.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const da = nodeCrypto.createHash("sha256").update(a).digest();
  const db = nodeCrypto.createHash("sha256").update(b).digest();
  return nodeCrypto.timingSafeEqual(da, db);
}
