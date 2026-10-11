// A verified principal is used verbatim as `ctx.caller`, the same namespace as the server's own
// fixed identities (`stdio`, `http-local`, the CLI workers, `rerun:*`). A token with `sub=stdio`
// therefore shared stdio's idempotency rows, work memory and sessions. The stored identities are
// not renamed (that would orphan existing state): no verified credential may take one.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { claimOperator } from "../src/auth/as-operator-store";
import { AuthRejection, identityFrom, verifyJwt } from "../src/auth/jwt";
import {
  isReservedPrincipal,
  RESERVED_PRINCIPAL_PREFIXES,
  RESERVED_PRINCIPALS,
} from "../src/auth/reserved-principals";
import { CliError } from "../src/cli/args";
import { planMint } from "../src/cli/commands/token-mint";
import { provisionOauthDb } from "../src/db/provision";
import { openMemoryDb } from "./helpers";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const secret = "x".repeat(32);
const key = new TextEncoder().encode(secret);
const mint = (claims: Record<string, unknown>) =>
  new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setExpirationTime("5m").sign(key);

const SAMPLES = [...RESERVED_PRINCIPALS, "rerun:alice", "rerun:", "internal:scheduler"];

async function rejection(p: Promise<unknown>): Promise<AuthRejection> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AuthRejection) return e;
    throw e;
  }
  throw new Error("expected a rejection, got success");
}

describe("isReservedPrincipal", () => {
  it("is exact for names, prefix-based for namespaces, and case-sensitive", () => {
    for (const s of SAMPLES) expect(isReservedPrincipal(s), s).toBe(true);
    for (const s of ["alice", "stdio2", "my-stdio", "Stdio", "rerun", "internal", "usr_abc", ""])
      expect(isReservedPrincipal(s), s).toBe(false);
    expect(isReservedPrincipal(null)).toBe(false);
  });
});

describe("the verifier refuses a reserved principal", () => {
  it.each(SAMPLES)("jwt mode: sub=%s", async (sub) => {
    const e = await rejection(verifyJwt(await mint({ sub }), secret));
    expect(e.reason).toBe("reserved_principal");
  });

  it("an ordinary sub is still accepted (usability: only the reserved names are lost)", async () => {
    const id = await verifyJwt(await mint({ sub: "stdio-bot" }), secret);
    expect(id.caller).toBe("stdio-bot");
  });

  it("oidc claimMapping: the RESOLVED principal is checked, whichever claim supplies it", () => {
    const base = { scopes: "scope" };
    const viaSubject = { ...base, subject: "email" };
    const viaPrincipal = { ...base, subject: "sub", principal: "preferred_username" };
    expect(() =>
      identityFrom(
        { sub: "u1", email: "http-local", scope: "read:notes" },
        undefined,
        {},
        viaSubject,
      ),
    ).toThrowError(expect.objectContaining({ reason: "reserved_principal" }));
    expect(() =>
      identityFrom(
        { sub: "u1", preferred_username: "rerun:u1", scope: "read:notes" },
        undefined,
        {},
        viaPrincipal,
      ),
    ).toThrowError(expect.objectContaining({ reason: "reserved_principal" }));
    // The raw `sub` is not the principal when a mapping names another claim.
    expect(
      identityFrom({ sub: "stdio", email: "a@b.c", scope: "" }, undefined, {}, viaSubject).caller,
    ).toBe("a@b.c");
  });
});

describe("token mint", () => {
  it.each(SAMPLES)("refuses --sub %s", (sub) => {
    expect(() =>
      planMint({ mode: "jwt" }, { kind: "token-mint", sub }, 1_700_000_000),
    ).toThrowError(CliError);
    expect(() => planMint({ mode: "jwt" }, { kind: "token-mint", sub }, 1_700_000_000)).toThrow(
      /reserved/,
    );
  });
});

describe("the bundled authorization server", () => {
  it("derives every user's sub as usr_<random>, which is never reserved", () => {
    const db = openMemoryDb();
    provisionOauthDb(db, { version: "t" });
    const claim = claimOperator(db, { username: "stdio", passwordHash: "x", now: 1 });
    if (!claim.ok) throw new Error("claim failed");
    // A username that spells a reserved name does not become the sub.
    expect(claim.sub).toMatch(/^usr_[A-Za-z0-9_-]{20,}$/);
    expect(isReservedPrincipal(claim.sub)).toBe(false);
  });
});

describe("every internal caller string in src is reserved", () => {
  function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...tsFiles(p));
      else if (e.name.endsWith(".ts") && e.name !== "migrations-embedded.ts") out.push(p);
    }
    return out;
  }
  /** `caller: "x"`, `cmd.caller ?? "x"` and `*_CALLER_PREFIX = "x"` in non-test source. */
  const LITERAL = /\bcaller\s*(?::|\?\?)\s*"([^"\n]+)"|\b\w*CALLER\w*\s*=\s*"([^"\n]+)"/g;
  const found = new Map<string, string>();
  for (const f of tsFiles(SRC)) {
    for (const m of readFileSync(f, "utf8").matchAll(LITERAL))
      found.set((m[1] ?? m[2]) as string, f.slice(SRC.length));
  }

  it("the scan finds the known callers (not vacuous)", () => {
    for (const known of [
      "stdio",
      "http-local",
      "cli-operator",
      "prefetch-worker",
      "memory-import-cli",
      "rerun:",
    ])
      expect([...found.keys()], `scan missed ${known}`).toContain(known);
  });

  /** Fallback LABELS for "no caller", not identities anything is stored under. */
  const NOT_AN_IDENTITY: Record<string, string> = {
    unknown: "summarize-episode.ts: display text in an episode gist",
    anonymous: "throttle.ts: the rate-limit bucket label for a call with no caller",
  };

  it("each is in the reserved set or under a reserved prefix", () => {
    const unreserved = [...found].filter(
      ([s]) => !isReservedPrincipal(s) && !(s in NOT_AN_IDENTITY),
    );
    expect(
      unreserved,
      `internal caller string(s) a verified token could also take; add to reserved-principals.ts: ${unreserved.map(([s, f]) => `${s} (${f})`).join(", ")}`,
    ).toEqual([]);
  });

  it("no exact name is stale: each reserved name still appears in src", () => {
    const stale = [...RESERVED_PRINCIPALS].filter((s) => !found.has(s));
    expect(stale).toEqual([]);
    expect(RESERVED_PRINCIPAL_PREFIXES.length).toBeGreaterThan(0);
  });
});
