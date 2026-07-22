import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configFromVaultPath,
  parseCliArgs,
  redactConfig,
  resolveServeConfig,
} from "../src/cli/args";

describe("parseCliArgs doctor (THE-521)", () => {
  it("bare doctor -> doctor with json:false", () => {
    expect(parseCliArgs(["doctor"])).toEqual({ kind: "doctor", json: false });
  });
  it("doctor --json sets json:true", () => {
    const c = parseCliArgs(["doctor", "--json"]);
    expect(c.kind).toBe("doctor");
    if (c.kind === "doctor") expect(c.json).toBe(true);
  });
  it("doctor --token <jwt> captures the token without eating the config path", () => {
    const c = parseCliArgs(["doctor", "cfg.json", "--token", "aaa.bbb.ccc", "--json"]);
    expect(c.kind).toBe("doctor");
    if (c.kind === "doctor") {
      expect(c.token).toBe("aaa.bbb.ccc");
      expect(c.configPath).toBe("cfg.json");
      expect(c.json).toBe(true);
    }
  });
  it("doctor --config <path> is honoured", () => {
    const c = parseCliArgs(["doctor", "--config", "/etc/o.json"]);
    if (c.kind === "doctor") expect(c.configPath).toBe("/etc/o.json");
  });
});

describe("parseCliArgs", () => {
  it("no args -> serve (env fallback handled at resolve time)", () => {
    expect(parseCliArgs([])).toEqual({ kind: "serve" });
  });
  it("version + help flags", () => {
    expect(parseCliArgs(["version"]).kind).toBe("version");
    expect(parseCliArgs(["--version"]).kind).toBe("version");
    expect(parseCliArgs(["-v"]).kind).toBe("version");
    expect(parseCliArgs(["help"]).kind).toBe("help");
    expect(parseCliArgs(["--help"]).kind).toBe("help");
  });
  it("a bare path is a serve target (back-compat)", () => {
    expect(parseCliArgs(["/vault"])).toEqual({ kind: "serve", input: "/vault" });
    expect(parseCliArgs(["./obsidian-tc.config.json"])).toEqual({
      kind: "serve",
      input: "./obsidian-tc.config.json",
    });
  });
  it("serve with positional and --config", () => {
    expect(parseCliArgs(["serve", "/vault"])).toEqual({ kind: "serve", input: "/vault" });
    expect(parseCliArgs(["serve", "--config", "/c.json"])).toEqual({
      kind: "serve",
      input: "/c.json",
    });
  });
  it("config show / validate", () => {
    expect(parseCliArgs(["config", "show"])).toEqual({
      kind: "config-show",
      configPath: undefined,
    });
    expect(parseCliArgs(["config", "show", "/c.json"])).toEqual({
      kind: "config-show",
      configPath: "/c.json",
    });
    expect(parseCliArgs(["config", "validate", "--config", "/c.json"])).toEqual({
      kind: "config-validate",
      configPath: "/c.json",
    });
  });
  it("unknown config subcommand + unknown option are errors", () => {
    expect(parseCliArgs(["config", "bogus"]).kind).toBe("error");
    expect(parseCliArgs(["--bogus"]).kind).toBe("error");
  });
  it("--config with no value is a usage error, not a silent positional/env fallback", () => {
    expect(parseCliArgs(["serve", "--config"])).toEqual({
      kind: "error",
      message: "--config requires a value",
    });
    expect(parseCliArgs(["config", "show", "--config"]).kind).toBe("error");
    // a following token that is itself a flag does not count as the value
    expect(parseCliArgs(["serve", "--config", "--bogus"]).kind).toBe("error");
  });
});

describe("resolveServeConfig / configFromVaultPath", () => {
  it("a directory boots a single vault 'main'", () => {
    const dir = mkdtempSync(join(tmpdir(), "otc-vault-"));
    const cfg = resolveServeConfig(dir);
    expect(cfg.vaults).toHaveLength(1);
    expect(cfg.vaults[0]?.id).toBe("main");
    expect(cfg.vaults[0]?.path).toBe(resolve(dir));
    // cacheDir must be absolute + machine-local, not CWD-relative: a GUI launcher (Claude Desktop)
    // spawns MCP servers in a non-writable CWD, so a relative ".obsidian-tc" would EPERM at boot.
    expect(isAbsolute(cfg.cacheDir)).toBe(true);
    expect(cfg.cacheDir).toBe(join(homedir(), ".obsidian-tc"));
  });
  it("a config file is loaded as written", () => {
    const dir = mkdtempSync(join(tmpdir(), "otc-cfg-"));
    const file = join(dir, "c.json");
    writeFileSync(file, JSON.stringify({ vaults: [{ id: "v1", path: dir }] }));
    expect(resolveServeConfig(file).vaults[0]?.id).toBe("v1");
  });
  it("cacheDir: explicit absolute is preserved; relative is anchored to home", () => {
    const dir = mkdtempSync(join(tmpdir(), "otc-cache-"));
    const abs = join(dir, "cache");
    writeFileSync(
      join(dir, "abs.json"),
      JSON.stringify({ vaults: [{ id: "v", path: dir }], cacheDir: abs }),
    );
    expect(resolveServeConfig(join(dir, "abs.json")).cacheDir).toBe(abs);
    writeFileSync(
      join(dir, "rel.json"),
      JSON.stringify({ vaults: [{ id: "v", path: dir }], cacheDir: "mycache" }),
    );
    expect(resolveServeConfig(join(dir, "rel.json")).cacheDir).toBe(join(homedir(), "mycache"));
  });
  it("a missing target throws a friendly error", () => {
    expect(() => resolveServeConfig(join(tmpdir(), "otc-definitely-missing-xyz"))).toThrow(
      /no such/i,
    );
  });
  it("configFromVaultPath fills schema defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "otc-def-"));
    const cfg = configFromVaultPath(dir);
    expect(cfg.auth.mode).toBe("none");
    expect(cfg.governor.maxResponseBytes).toBeGreaterThan(0);
  });
});

describe("redactConfig", () => {
  it("masks secret-looking keys and leaks no secret value", () => {
    const json = JSON.stringify(
      redactConfig({
        auth: { mode: "jwt", jwtSecret: "supersecret" },
        vaults: [{ id: "main", path: "/v", restApiKey: "abc123" }],
        plur: { endpoint: "http://x", apiKey: "tok-xyz" },
        governor: { maxResponseBytes: 1000000 },
      }),
    );
    expect(json).not.toContain("supersecret");
    expect(json).not.toContain("abc123");
    expect(json).not.toContain("tok-xyz");
    expect(json).toContain('"jwtSecret":"<redacted>"');
    expect(json).toContain('"restApiKey":"<redacted>"');
    expect(json).toContain('"apiKey":"<redacted>"');
    expect(json).toContain('"endpoint":"http://x"');
    expect(json).toContain('"maxResponseBytes":1000000');
  });
  it("masks generic key-suffix fields without over-matching non-key names", () => {
    const json = JSON.stringify(
      redactConfig({ signingKey: "s1", privateKey: "p1", encryptionKey: "e1", keyPath: "/etc/x" }),
    );
    expect(json).not.toContain("s1");
    expect(json).not.toContain("p1");
    expect(json).not.toContain("e1");
    expect(json).toContain('"signingKey":"<redacted>"');
    expect(json).toContain('"privateKey":"<redacted>"');
    expect(json).toContain('"encryptionKey":"<redacted>"');
    // keyPath ends in "path", not "key": it is a file location, not the secret, so it stays.
    expect(json).toContain('"keyPath":"/etc/x"');
  });
});

describe("parseCliArgs — flag validation", () => {
  it("a value-taking flag with no value is a usage error, not a crash", () => {
    expect(parseCliArgs(["serve", "--config"]).kind).toBe("error");
    expect(parseCliArgs(["config", "validate", "--config"]).kind).toBe("error");
  });
});

describe("redactConfig — generic key-suffix fields", () => {
  it("masks any *key/*secret/*token field, including signing/private keys", () => {
    const json = JSON.stringify(
      redactConfig({ signingKey: "sk-1", privateKey: "pk-2", publicId: "ok" }),
    );
    expect(json).not.toContain("sk-1");
    expect(json).not.toContain("pk-2");
    expect(json).toContain('"signingKey":"<redacted>"');
    expect(json).toContain('"privateKey":"<redacted>"');
    expect(json).toContain('"publicId":"ok"');
  });
});
