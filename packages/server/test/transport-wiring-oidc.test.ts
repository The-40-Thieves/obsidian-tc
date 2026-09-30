// wireTransports and `auth.mode: "oidc"`: discovery runs at boot and a failure refuses to start.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterAll, expect, it } from "vitest";
import { MetricsRecorder } from "../src/metrics/registry";
import { wireTransports } from "../src/runtime/transport-wiring";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

it("wireTransports refuses to boot an oidc server whose IdP cannot be discovered, naming the issuer", async () => {
  const root = mkdtempSync(join(tmpdir(), "tw-oidc-"));
  dirs.push(root);
  const config = ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: root }],
    cacheDir: join(root, "cache"),
    auth: {
      mode: "oidc",
      oidc: { issuer: "https://oidc-boot-test.invalid", audience: "https://x.example.com/mcp" },
    },
    transports: { stdio: false, http: { enabled: true, host: "127.0.0.1", port: 47999 } },
  });
  const deps = {
    config,
    version: "t",
    registry: {},
    vaultRegistry: {},
    db: openMemoryDb(),
    firstVaultId: "v1",
    acl: {},
    jobQueue: {},
    metrics: new MetricsRecorder(),
  } as unknown as Parameters<typeof wireTransports>[0];
  await expect(wireTransports(deps)).rejects.toThrow(/oidc-boot-test\.invalid/);
}, 30_000);
