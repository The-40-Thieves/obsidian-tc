// `conventions.protectSchemaFiles` read from a config file, through the real loader and the ACL
// builder the server runs at boot. A helper that sets the key on an in-memory vault would pass while
// the config path stayed broken, so this loads the file.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load";
import { buildAcls } from "../src/runtime/acl-build";
import { enforcePathAcl } from "../src/vault/acl-path";
import { makeTempDir, rmTemp } from "./tmp";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmTemp(dirs.pop() as string);
});

function vaultFixture(conventions: Record<string, unknown> | undefined): {
  configPath: string;
  root: string;
} {
  const dir = makeTempDir("conv-config-");
  dirs.push(dir);
  const root = join(dir, "vault");
  mkdirSync(join(root, "F"), { recursive: true });
  writeFileSync(join(root, "F", "SCHEMA.md"), "---\ntype: layer\n---\n");
  const vault = { id: "test", path: root, ...(conventions ? { conventions } : {}) };
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ cacheDir: join(dir, "cache"), vaults: [vault] }));
  return { configPath, root };
}

/** The error a call throws, or undefined when it returns. */
function refusal(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("conventions.protectSchemaFiles from a parsed config", () => {
  it("a config that sets the key yields an ACL that refuses a non-admin write to SCHEMA.md", () => {
    const { configPath, root } = vaultFixture({ protectSchemaFiles: true });
    const cfg = loadConfig(configPath);
    const { aclByVault } = buildAcls(cfg.acl, cfg.vaults);
    const acl = aclByVault.get("test");
    expect(acl?.protectsSchemaFiles).toBe(true);
    expect(
      refusal(() => enforcePathAcl(acl, "write", "F/SCHEMA.md", root, ["write:*"])),
    ).toMatchObject({
      code: "acl_denied",
      details: { reason: "schema_file" },
    });
    expect(
      refusal(() =>
        enforcePathAcl(acl, "write", "F/SCHEMA.md", root, ["write:*", "admin:conventions"]),
      ),
    ).toBeUndefined();
  });

  it("a config that omits the key leaves SCHEMA.md writable by a non-admin", () => {
    const { configPath, root } = vaultFixture(undefined);
    const cfg = loadConfig(configPath);
    const { aclByVault } = buildAcls(cfg.acl, cfg.vaults);
    expect(aclByVault.get("test")?.protectsSchemaFiles ?? false).toBe(false);
    expect(
      refusal(() =>
        enforcePathAcl(aclByVault.get("test"), "write", "F/SCHEMA.md", root, ["write:*"]),
      ),
    ).toBeUndefined();
  });
});
