// `obsidian-tc auth rotate-key|list|revoke` and `auth as set-password` argv parsing. Split out of args.ts for the same reason
// parse-telemetry.ts documents: args.ts sits at biome's file-length floor. No dependency on
// args.ts, so importing it from there creates no cycle.
import {
  isKeyAlg,
  isKeyPurpose,
  type KeyAlg,
  type KeyPurpose,
  MAX_ROTATION_GRACE_SECONDS,
} from "../auth/signing-keys";
import { CliError } from "./cli-error";
import { flagValue, positional } from "./flag-value";

export interface AuthCommand {
  kind: "auth";
  sub: "rotate-key" | "list" | "revoke" | "as-set-password";
  configPath?: string;
  json?: boolean;
  /** `revoke`: the token id to revoke. */
  jti?: string;
  /** `revoke`: free-text reason recorded with the revocation. */
  reason?: string;
  /** `rotate-key`: seconds the previous key keeps verifying. Absent -> auth.rotationGraceSeconds
   *  (default 0, immediate). An explicit 0 overrides a non-zero config default. */
  graceSeconds?: number;
  /** `rotate-key`: algorithm of the new key. Default HS256 (`mint`) or ES256 (`as`). */
  alg?: KeyAlg;
  /** `rotate-key`: which key to rotate, `mint` (default: hand-minted tokens) or `as` (the
   *  authorization server's access-token key). The other purpose's key is untouched. */
  purpose?: KeyPurpose;
  /** `list`: include expired tokens. */
  all?: boolean;
  /** `list`: show signing keys instead of tokens. */
  keys?: boolean;
  /** `as set-password`: the operator account name (default `operator`). */
  user?: string;
  /** `as set-password`: read the password from standard input instead of prompting. */
  stdin?: boolean;
}

const SUBS = ["rotate-key", "list", "revoke"] as const;
const VALUE_FLAGS = ["--config", "--reason", "--grace", "--alg", "--purpose", "--user"];

/** `auth as <sub>`: only `set-password` exists. */
function parseAuthAs(rest: string[]): AuthCommand | { kind: "error"; message: string } {
  if (rest[0] !== "set-password") {
    return { kind: "error", message: `unknown auth as subcommand: ${rest[0] ?? "(none)"}` };
  }
  const args = rest.slice(1);
  const user = flagValue(args, "--user");
  const scan = args.filter((a, i) => {
    if (a.startsWith("-")) return false;
    const prev = args[i - 1];
    return !(prev !== undefined && VALUE_FLAGS.includes(prev));
  });
  const configPath = flagValue(args, "--config") ?? positional(scan);
  return {
    kind: "auth",
    sub: "as-set-password",
    ...(configPath !== undefined ? { configPath } : {}),
    json: args.includes("--json"),
    stdin: args.includes("--stdin"),
    ...(user !== undefined ? { user } : {}),
  };
}

export function parseAuth(rest: string[]): AuthCommand | { kind: "error"; message: string } {
  if (rest[0] === "as") return parseAuthAs(rest.slice(1));
  const sub = SUBS.find((s) => s === rest[0]);
  if (sub === undefined) {
    return { kind: "error", message: `unknown auth subcommand: ${rest[0] ?? "(none)"}` };
  }
  const args = rest.slice(1);
  // Value-taking flags are stripped before the positional scan so a flag's VALUE (a reason
  // sentence, a number) is never mistaken for the jti or the config path.
  const scan = args.filter((a, i) => {
    if (a.startsWith("-")) return false;
    const prev = args[i - 1];
    return !(prev !== undefined && VALUE_FLAGS.includes(prev));
  });
  if (args.includes("--stdin") || flagValue(args, "--user") !== undefined) {
    throw new CliError("--stdin and --user apply only to `auth as set-password`");
  }
  const configFlag = flagValue(args, "--config");
  let jti: string | undefined;
  let configPositional = scan;
  if (sub === "revoke") {
    jti = scan[0];
    if (jti === undefined) throw new CliError("auth revoke requires a <jti>");
    configPositional = scan.slice(1);
  }
  const configPath = configFlag ?? positional(configPositional);
  const graceRaw = flagValue(args, "--grace");
  const graceSeconds = graceRaw === undefined ? undefined : Number(graceRaw);
  if (graceSeconds !== undefined && !(Number.isFinite(graceSeconds) && graceSeconds >= 0)) {
    throw new CliError(`--grace must be a non-negative number of seconds, got: ${graceRaw}`);
  }
  if (graceSeconds !== undefined && graceSeconds > MAX_ROTATION_GRACE_SECONDS) {
    throw new CliError(
      `--grace is capped at ${MAX_ROTATION_GRACE_SECONDS} seconds (7 days), got: ${graceRaw}`,
    );
  }
  const algRaw = flagValue(args, "--alg");
  if (algRaw !== undefined && !isKeyAlg(algRaw)) {
    throw new CliError(`--alg must be one of HS256, ES256, EdDSA, got: ${algRaw}`);
  }
  if (algRaw !== undefined && sub !== "rotate-key") {
    throw new CliError("--alg applies only to `auth rotate-key`");
  }
  const purposeRaw = flagValue(args, "--purpose");
  if (purposeRaw !== undefined && !isKeyPurpose(purposeRaw)) {
    throw new CliError(`--purpose must be one of mint, as, got: ${purposeRaw}`);
  }
  if (purposeRaw !== undefined && sub !== "rotate-key") {
    throw new CliError("--purpose applies only to `auth rotate-key`");
  }
  const reason = flagValue(args, "--reason");
  return {
    kind: "auth",
    sub,
    ...(configPath !== undefined ? { configPath } : {}),
    json: args.includes("--json"),
    ...(jti !== undefined ? { jti } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(graceSeconds !== undefined ? { graceSeconds } : {}),
    ...(algRaw !== undefined ? { alg: algRaw } : {}),
    ...(purposeRaw !== undefined ? { purpose: purposeRaw as KeyPurpose } : {}),
    all: args.includes("--all"),
    keys: args.includes("--keys"),
  };
}
