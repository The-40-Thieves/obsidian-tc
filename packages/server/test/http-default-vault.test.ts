// An HTTP caller with no vault claim and no grant vault (an unbound OAuth token) is pinned to the
// server's DEFAULT vault: OBSIDIAN_TC_DEFAULT_VAULT when it names a configured vault, else the first
// one. server-runtime used to hand the HTTP transport `config.vaults[0]` regardless of the env var,
// so the registry said "main" while every unbound token was pinned to "agents".
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildServerRuntime } from "../src/runtime/server-runtime";
import * as http from "../src/transports/http";
import { makeTempDir, rmTemp } from "./tmp";

// Stubbed so nothing binds a port: the test only reads the options the runtime hands the transport.
vi.mock("../src/transports/http", () => ({
  startHttp: vi.fn(async () => ({ port: 1, close: async () => {} })),
}));

const ENV = "OBSIDIAN_TC_DEFAULT_VAULT";
const dirs: string[] = [];
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV];
  delete process.env[ENV];
  vi.mocked(http.startHttp).mockClear();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  for (const d of dirs.splice(0)) rmTemp(d);
});

/** Boots the real runtime over two vaults, `[agents, main]`, and returns the `vaultId` the HTTP
 *  transport was constructed with: the fallback for every caller that carries no vault. */
async function httpFallbackVault(defaultVault?: string): Promise<string | undefined> {
  const base = makeTempDir("otc-http-default-vault-");
  dirs.push(base);
  const agents = join(base, "agents");
  const main = join(base, "main");
  mkdirSync(agents);
  mkdirSync(main);
  if (defaultVault !== undefined) process.env[ENV] = defaultVault;
  const config = ServerConfigSchema.parse({
    vaults: [
      { id: "agents", path: agents },
      { id: "main", path: main },
    ],
    cacheDir: join(base, "cache"),
    transports: { stdio: false, http: { enabled: true, host: "127.0.0.1", port: 47997 } },
  });
  const runtime = await buildServerRuntime(config, join(base, "config.json"));
  try {
    return vi.mocked(http.startHttp).mock.calls[0]?.[0].vaultId;
  } finally {
    await runtime.close("test cleanup");
  }
}

it("an unbound HTTP caller falls back to OBSIDIAN_TC_DEFAULT_VAULT when it names the second vault", async () => {
  expect(await httpFallbackVault("main")).toBe("main");
});

it("with OBSIDIAN_TC_DEFAULT_VAULT unset, the first configured vault is still the fallback", async () => {
  expect(await httpFallbackVault()).toBe("agents");
});

it("an OBSIDIAN_TC_DEFAULT_VAULT naming no configured vault falls back to the first vault", async () => {
  expect(await httpFallbackVault("no-such-vault")).toBe("agents");
});
