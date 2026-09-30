// `obsidian-tc auth rotate-key|list|revoke` argv parsing. Split out of args.ts for the same reason
// parse-telemetry.ts documents: args.ts sits at biome's file-length floor. No dependency on
// args.ts, so importing it from there creates no cycle.
import { isKeyAlg, type KeyAlg, MAX_ROTATION_GRACE_SECONDS } from "../auth/signing-keys";
import { CliError } from "./cli-error";
import { flagValue, positional } from "./flag-value";

export interface AuthCommand {
  kind: "auth";
  sub: "rotate-key" | "list" | "revoke";
  configPath?: string;
  json?: boolean;
  /** `revoke`: the token id to revoke. */
  jti?: string;
  /** `revoke`: free-text reason recorded with the revocation. */
  reason?: string;
  /** `rotate-key`: seconds the previous key keeps verifying. Absent -> auth.rotationGraceSeconds
   *  (default 0, immediate). An explicit 0 overrides a non-zero config default. */
  graceSeconds?: number;
  /** `rotate-key`: algorithm of the new key. Default HS256. */
  alg?: KeyAlg;
  /** `list`: include expired tokens. */
  all?: boolean;
  /** `list`: show signing keys instead of tokens. */
  keys?: boolean;
}

const SUBS = ["rotate-key", "list", "revoke"] as const;
const VALUE_FLAGS = ["--config", "--reason", "--grace", "--alg"];

export function parseAuth(rest: string[]): AuthCommand | { kind: "error"; message: string } {
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
    all: args.includes("--all"),
    keys: args.includes("--keys"),
  };
}
