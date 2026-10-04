// The per-server secret (auth/server-secret.ts) and what is derived from it: the wiki seal key
// (raw, unchanged) and the HITL codec key (HKDF, its own label).
import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readServerSecret, serverSecret } from "../src/auth/server-secret";
import {
  createElicitCodec,
  createServerElicitCodec,
  deriveRequestStateKey,
  deriveServerElicitKey,
} from "../src/elicit-request-state";
import { inspectGenerated, seal } from "../src/tools/m7/knowledge/wiki-generated-seal";
import {
  bootHitl,
  callDanger,
  completed,
  HS_SECRET,
  hsConfig,
  offer,
  oidcConfig,
  signHs,
  stubVerifier,
} from "./hitl-wire-helpers";
import { stallTimeout } from "./stall-timeouts";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "obtc-server-secret-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const SECRET = "A".repeat(43);

describe("serverSecret", () => {
  it("creates one stable 32-byte base64url secret, 0600 in a 0700 directory", () => {
    const dir = tmp();
    const first = serverSecret(dir);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(serverSecret(dir)).toBe(first);
    expect(readServerSecret(dir)).toBe(first);
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "server-secrets")).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "server-secrets", "wiki-generated.key")).mode & 0o777).toBe(0o600);
    }
  });

  it("adopts a key a wiki-seal-era server already wrote and never replaces it", () => {
    const dir = tmp();
    mkdirSync(join(dir, "server-secrets"), { mode: 0o700 });
    const file = join(dir, "server-secrets", "wiki-generated.key");
    writeFileSync(file, SECRET, { mode: 0o600 });
    chmodSync(file, 0o600);
    expect(serverSecret(dir)).toBe(SECRET);
    expect(serverSecret(dir)).toBe(SECRET);
  });

  it("read-only lookup of a missing secret creates nothing", () => {
    const dir = tmp();
    expect(readServerSecret(dir)).toBeUndefined();
    expect(() => statSync(join(dir, "server-secrets"))).toThrow();
  });
});

describe("independent derivations of the one secret", () => {
  it("keeps the wiki seal byte-identical: the raw secret is the HMAC key under the seal's own prefix", () => {
    const id = { vaultId: "alpha", path: "wiki/log.md" };
    const page = `---\ngenerated_by: obsidian-tc\ngenerated_vault: "alpha"\ngenerated_path: "wiki/log.md"\ngenerated_hash: \n---\n# Wiki log\n`;
    const expected = createHmac("sha256", SECRET)
      .update(JSON.stringify(["obsidian-tc/wiki-generated/v1", id.vaultId, id.path, page]), "utf8")
      .digest("hex");
    const sealed = seal(page, SECRET, id);
    expect(sealed).toContain(`generated_hash: hmac-sha256:${expected}`);
    expect(inspectGenerated(sealed, SECRET, id)).toBe("ours");
  });

  it("derives an elicit key that is neither the raw secret nor any other label's key", () => {
    const key = hex(deriveServerElicitKey(SECRET));
    expect(key).toHaveLength(64);
    expect(key).not.toBe(Buffer.from(SECRET).toString("hex"));
    expect(key).not.toBe(hex(deriveRequestStateKey(SECRET)));
    expect(key).not.toBe(hex(deriveServerElicitKey(`${SECRET}x`)));
    expect(hex(deriveServerElicitKey(SECRET))).toBe(key);
  });

  it("a state sealed under the server codec does not verify under a jwtSecret-style codec", async () => {
    const payload = { tool: "t", argsHash: "h", vaultId: "v", caller: null };
    const state = await createServerElicitCodec(SECRET, 300).mint(payload);
    await expect(createElicitCodec(SECRET, 300).verify(state)).rejects.toThrow();
    await expect(createServerElicitCodec(SECRET, 300).verify(state)).resolves.toMatchObject(
      payload,
    );
  });
});

// Migration decision (changes/hitl-codec-server-secret.md): no dual-key verify. A confirmation that
// was pending across the upgrade was keyed from `jwtSecret`; it is refused once and the client is
// offered a fresh one, within the 300 s TTL it would have had anyway. Keeping a jwtSecret-derived
// verify path would keep the very coupling this removes.
describe("upgrade: a state minted under the old jwtSecret keying", () => {
  it(
    "is refused, never authorizes the call, and a fresh call is offered a new confirmation",
    async () => {
      const dir = tmp();
      const seed = await bootHitl({ auth: oidcConfig(), cacheDir: dir, verifier: stubVerifier });
      let payload: Awaited<ReturnType<ReturnType<typeof createServerElicitCodec>["verify"]>>;
      try {
        const real = await offer(seed.port, "t");
        payload = await createServerElicitCodec(serverSecret(dir), 300).verify(real);
      } finally {
        await seed.close();
      }
      const oldState = await createElicitCodec(HS_SECRET, 300).mint(payload);
      const newState = await createServerElicitCodec(serverSecret(dir), 300).mint(payload);

      const app = await bootHitl({ auth: hsConfig(HS_SECRET), cacheDir: dir });
      try {
        const jwt = await signHs();
        // Control: the same payload under the new keying completes, so the payload is valid and
        // only the key differs.
        expect(completed(await callDanger(app.port, jwt, newState))).toBe(true);
        const before = app.effect.applied;
        expect(completed(await callDanger(app.port, jwt, oldState))).toBe(false);
        expect(app.effect.applied).toBe(before);
        const reoffer = await callDanger(app.port, jwt);
        expect(reoffer.result?.resultType).toBe("input_required");
      } finally {
        await app.close();
      }
    },
    stallTimeout(25_000),
  );
});
