// THE-521 — assembling and running the default doctor check set.
import type { CapabilityProfile } from "../capability";
import type { TokenClaims } from "./checks";
import {
  authMaxAgeCheck,
  authPolicyCheck,
  nativeCheck,
  obsidianCheck,
  runtimeCheck,
} from "./checks";
import { runDoctor } from "./report";
import type { Check, DoctorReport } from "./types";

/**
 * Decode a JWT's iat/exp claims WITHOUT verifying its signature. Doctor only needs the age math to run
 * auth.maxAge; verification would require the secret and is a different concern. Defensive: any
 * malformed input returns undefined so a garbage --token degrades to "no token", never a throw.
 */
export function decodeTokenClaims(token: string): TokenClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8"));
    if (typeof payload?.iat === "number" && typeof payload?.exp === "number") {
      return { iat: payload.iat, exp: payload.exp };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface DoctorConfigView {
  auth: { mode: "none" | "jwt"; tokenTtlSeconds: number; readOnly: boolean };
}

export interface AssembleOptions {
  config: DoctorConfigView;
  profile: CapabilityProfile;
  /** Deployed credential to inspect, as a raw JWT string. Optional. */
  token?: string;
  /** Injected clocks for determinism. */
  now?: () => string;
  nowSeconds?: () => number;
}

/** Build the default check set from config + capability profile (+ optional token) and run it. */
export async function assembleDoctorReport(opts: AssembleOptions): Promise<DoctorReport> {
  const { config, profile } = opts;
  const claims = opts.token ? decodeTokenClaims(opts.token) : undefined;

  const checks: Check[] = [
    runtimeCheck(profile),
    nativeCheck(profile),
    authPolicyCheck(config.auth),
    authMaxAgeCheck({ tokenTtlSeconds: config.auth.tokenTtlSeconds }, claims, opts.nowSeconds),
    obsidianCheck(profile),
  ];

  return runDoctor(checks, {
    serverVersion: profile.serverVersion,
    ...(opts.now ? { now: opts.now } : {}),
  });
}
