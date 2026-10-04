// The HITL codec is keyed from a server-local secret, so the modern `inputRequired` round trip
// exists in EVERY HTTP auth mode and survives a `jwtSecret` change.
//
// Before: `createHttpApp` built the codec only `if (opts.auth.jwtSecret)`. Under `oidc` mode and
// asymmetric-only `jwt` (a JWKS, no secret) there was no codec at all, so a destructive call got
// the plain `elicit_required` error and a generic client could never complete it; and rotating
// `jwtSecret` silently voided every pending confirmation.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootHitl,
  callDanger,
  completed,
  HS_SECRET,
  hsConfig,
  jwksFixture,
  offer,
  oidcConfig,
  signHs,
  stubVerifier,
} from "./hitl-wire-helpers";
import { stallTimeout } from "./stall-timeouts";

const dirs: string[] = [];
const cacheDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "obtc-hitl-secret-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T = stallTimeout(25_000);

describe("HITL round trip in every HTTP auth mode", () => {
  it(
    "oidc mode offers inputRequired and completes on the echoed state",
    async () => {
      const h = await bootHitl({
        auth: oidcConfig(),
        cacheDir: cacheDir(),
        verifier: stubVerifier,
      });
      try {
        const first = await callDanger(h.port, "any-oidc-bearer");
        expect(first.result?.resultType).toBe("input_required");
        expect(typeof first.result?.requestState).toBe("string");
        const second = await callDanger(h.port, "any-oidc-bearer", first.result.requestState);
        expect(completed(second)).toBe(true);
        expect(h.effect.applied).toBe(1);
      } finally {
        await h.close();
      }
    },
    T,
  );

  it(
    "asymmetric-only jwt (JWKS, no jwtSecret) offers inputRequired and completes",
    async () => {
      const fx = await jwksFixture();
      expect(fx.auth.jwtSecret).toBeUndefined();
      const h = await bootHitl({ auth: fx.auth, cacheDir: cacheDir() });
      try {
        const jwt = await fx.sign();
        const state = await offer(h.port, jwt);
        expect(completed(await callDanger(h.port, jwt, state))).toBe(true);
      } finally {
        await h.close();
      }
    },
    T,
  );

  it(
    "HS256 jwtSecret mode still round-trips",
    async () => {
      const h = await bootHitl({ auth: hsConfig(), cacheDir: cacheDir() });
      try {
        const jwt = await signHs();
        const state = await offer(h.port, jwt);
        expect(completed(await callDanger(h.port, jwt, state))).toBe(true);
      } finally {
        await h.close();
      }
    },
    T,
  );

  it(
    "an embedder that supplies no cacheDir still gets a codec (per-process secret)",
    async () => {
      const h = await bootHitl({ auth: oidcConfig(), verifier: stubVerifier });
      try {
        const state = await offer(h.port, "t");
        expect(completed(await callDanger(h.port, "t", state))).toBe(true);
      } finally {
        await h.close();
      }
    },
    T,
  );
});

describe("the codec key is the server-local secret, not jwtSecret", () => {
  it(
    "a state minted before a jwtSecret change verifies after it",
    async () => {
      const dir = cacheDir();
      const before = await bootHitl({ auth: hsConfig(HS_SECRET), cacheDir: dir });
      let state: string;
      try {
        state = await offer(before.port, await signHs(HS_SECRET));
      } finally {
        await before.close();
      }
      const rotated = `${HS_SECRET}-rotated`;
      const after = await bootHitl({ auth: hsConfig(rotated), cacheDir: dir });
      try {
        const done = await callDanger(after.port, await signHs(rotated), state);
        expect(completed(done)).toBe(true);
      } finally {
        await after.close();
      }
    },
    T,
  );

  it(
    "two apps on one cacheDir accept each other's state, whatever their auth mode",
    async () => {
      const dir = cacheDir();
      const a = await bootHitl({ auth: oidcConfig(), cacheDir: dir, verifier: stubVerifier });
      const fx = await jwksFixture();
      const b = await bootHitl({ auth: fx.auth, cacheDir: dir });
      try {
        const fromA = await offer(a.port, "t");
        expect(completed(await callDanger(b.port, await fx.sign(), fromA))).toBe(true);
        const fromB = await offer(b.port, await fx.sign());
        expect(completed(await callDanger(a.port, "t", fromB))).toBe(true);
      } finally {
        await a.close();
        await b.close();
      }
    },
    T,
  );

  it(
    "a state from another cacheDir (another server) is refused",
    async () => {
      const a = await bootHitl({
        auth: oidcConfig(),
        cacheDir: cacheDir(),
        verifier: stubVerifier,
      });
      const b = await bootHitl({
        auth: oidcConfig(),
        cacheDir: cacheDir(),
        verifier: stubVerifier,
      });
      try {
        const foreign = await offer(a.port, "t");
        const answer = await callDanger(b.port, "t", foreign);
        expect(completed(answer)).toBe(false);
        expect(b.effect.applied).toBe(0);
      } finally {
        await a.close();
        await b.close();
      }
    },
    T,
  );

  it(
    "creating the app writes the secret 0600 under <cacheDir>/server-secrets",
    async () => {
      const dir = cacheDir();
      const h = await bootHitl({ auth: oidcConfig(), cacheDir: dir, verifier: stubVerifier });
      try {
        const file = join(dir, "server-secrets", "wiki-generated.key");
        expect(statSync(file).isFile()).toBe(true);
        if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
      } finally {
        await h.close();
      }
    },
    T,
  );
});
