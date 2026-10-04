// `auth rotate-key --purpose as` sizes its grace window from the CONFIGURED access-token lifetime
// (`auth.as.accessTokenSeconds`), exactly as the boot-time key generation does. Review finding: the
// CLI used the 1800 s default for both the floor and the registry's refusal check, so a 3600 s
// deployment retired its old key while tokens it signed were still valid, and a 300 s one kept a
// retired key verifying for 1860 s.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run_auth } from "../src/cli/commands/auth";
import { makeTempDir, rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const dirs: string[] = [];
let out = "";
beforeEach(() => {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out += String(c);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmTemp(d);
});

function deployment(accessTokenSeconds: number, auth: Record<string, unknown> = {}) {
  const root = makeTempDir("as-rotate-life-");
  dirs.push(root);
  mkdirSync(join(root, "vault"));
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      vaults: [{ id: "main", path: join(root, "vault") }],
      cacheDir: join(root, "cache"),
      auth: {
        mode: "jwt",
        jwtSecret: SECRET,
        resource: "https://vault.example.com/mcp",
        as: { enabled: true, issuer: "https://vault.example.com", accessTokenSeconds },
        ...auth,
      },
    }),
  );
  return configPath;
}

async function rotate(configPath: string, extra: Record<string, unknown> = {}) {
  out = "";
  await run_auth({
    kind: "auth",
    sub: "rotate-key",
    configPath,
    json: true,
    purpose: "as",
    ...extra,
  } as never);
  return JSON.parse(out) as { previous_retire_after: number | null };
}

/** Seconds of grace the second rotation granted the first key. */
async function graceOfSecondRotation(configPath: string) {
  await rotate(configPath);
  const before = Date.now();
  const second = await rotate(configPath);
  expect(second.previous_retire_after).not.toBeNull();
  return Math.round(((second.previous_retire_after as number) - before) / 1000);
}

describe("`auth rotate-key --purpose as` honours auth.as.accessTokenSeconds", () => {
  it.each([
    [3600, 3660],
    [300, 360],
    [1800, 1860],
  ])("accessTokenSeconds %i -> a %i s grace window by default", async (lifetime, floor) => {
    const grace = await graceOfSecondRotation(deployment(lifetime, { rotationGraceSeconds: 0 }));
    expect(grace).toBeGreaterThanOrEqual(floor - 2);
    expect(grace).toBeLessThanOrEqual(floor + 30);
  });

  it("an explicit --grace below the configured lifetime's floor is refused, above it accepted", async () => {
    const configPath = deployment(3600);
    await rotate(configPath);
    await expect(rotate(configPath, { graceSeconds: 1900 })).rejects.toThrow(/3660/);
    await expect(rotate(configPath, { graceSeconds: 3700 })).resolves.toBeDefined();
  });

  it("a larger configured rotationGraceSeconds still wins over the floor", async () => {
    const grace = await graceOfSecondRotation(deployment(300, { rotationGraceSeconds: 7200 }));
    expect(grace).toBeGreaterThanOrEqual(7198);
  });
});
