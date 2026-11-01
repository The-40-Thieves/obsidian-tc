// clients.sameVaultRoot doctor check: does another MCP server in an MCP client config point at a
// configured vault root? Every filesystem input is injected (readFile/realpath/home/cwd/platform),
// so no real home directory is read and the same cases run on every OS.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type SameVaultRootIo,
  type SameVaultRootView,
  sameVaultRootCheck,
} from "../src/doctor/same-vault-root";

const ctx = { serverVersion: "test" };
const run = (view: SameVaultRootView) => sameVaultRootCheck(view).run(ctx);

interface FakeFs {
  /** path → file content; a path present here exists. */
  files?: Record<string, string>;
  /** directories that exist (vault roots, paths handed to a server). */
  dirs?: string[];
  /** symlink path → target; realpath follows it. */
  links?: Record<string, string>;
  /** paths whose read fails with a permission error. */
  throws?: string[];
  /** paths that exist but are not regular files (a FIFO or a device): read as not-a-file. */
  special?: string[];
}

function fakeIo(fs: FakeFs, over: Partial<SameVaultRootIo> = {}): SameVaultRootIo {
  const files = fs.files ?? {};
  const links = fs.links ?? {};
  const existing = new Set([...Object.keys(files), ...(fs.dirs ?? [])]);
  return {
    home: "/h",
    cwd: "/w/proj",
    platform: "linux",
    env: {},
    readFile: (p) => {
      if (fs.throws?.includes(p)) throw new Error("EACCES");
      if (fs.special?.includes(p)) return { kind: "not-a-file" };
      const text = files[p];
      return text === undefined ? { kind: "absent" } : { kind: "text", text };
    },
    realpath: (p) => links[p] ?? (existing.has(p) ? p : undefined),
    ...over,
  };
}

const claudeJson = (mcpServers: unknown) => JSON.stringify({ mcpServers });

/** A Claude Code config at /h/.claude.json, scanned against the one vault root /v/root. */
const scanClaude = (json: unknown) =>
  run({
    io: fakeIo({ files: { "/h/.claude.json": JSON.stringify(json) }, dirs: ["/v/root"] }),
    vaults: [{ id: "main", path: "/v/root" }],
  });

describe("clients.sameVaultRoot", () => {
  it("has the stable check id and the config category", () => {
    const check = sameVaultRootCheck({ io: fakeIo({}), vaults: [] });
    expect(check.id).toBe("clients.sameVaultRoot");
    expect(check.category).toBe("config");
  });

  it("is ok with no match and says how many client configs it compared", async () => {
    const io = fakeIo({
      files: { "/h/.claude.json": claudeJson({ solo: { command: "x", args: ["--flag"] } }) },
    });
    const r = await run({ io, vaults: [{ id: "main", path: "/v/root" }] });
    expect(r.status).toBe("ok");
    expect(r.summary).toBe(
      "no other MCP server in 1 client configs points at a configured vault root",
    );
    expect(r.remediation).toBeUndefined();
  });

  it("names the Claude Code server key that points at a vault root, never the path", async () => {
    const io = fakeIo(
      {
        files: {
          "/h/.claude.json": claudeJson({
            "mcp-obsidian": { command: "npx", args: ["-y", "mcp-obsidian", "/v/root"] },
          }),
        },
        dirs: ["/v/root"],
      },
      {},
    );
    const r = await run({ io, vaults: [{ id: "main", path: "/v/root" }] });
    expect(r.status).toBe("ok");
    expect(r.details?.sameRoot).toEqual(["claude-code:mcp-obsidian"]);
    expect(r.details?.scanned).toEqual(["claude-code"]);
    expect(r.summary).toContain("claude-code:mcp-obsidian");
    expect(r.remediation).toMatch(/split reads/);
    expect(JSON.stringify(r)).not.toContain("/v/root");
  });

  it("matches a path inside a root, a ~ path and a --flag=value; not an ancestor or a missing path", async () => {
    const io = fakeIo({
      files: {
        "/h/.claude.json": claudeJson({
          inside: { args: ["/v/root/notes"] },
          ancestor: { args: ["/v"] },
          missing: { args: ["/v/root/missing"] },
          tilde: { args: ["~/vault"] },
          flag: { args: ["--vault=/v/root/notes"] },
        }),
      },
      dirs: ["/v/root", "/v/root/notes", "/v", "/h/vault"],
    });
    const r = await run({
      io,
      vaults: [
        { id: "main", path: "/v/root" },
        { id: "home", path: "/h/vault" },
      ],
    });
    expect(r.details?.sameRoot).toEqual([
      "claude-code:inside",
      "claude-code:tilde",
      "claude-code:flag",
    ]);
  });

  it("matches through a symlink: the realpath resolves to the root", async () => {
    const io = fakeIo({
      files: { "/h/.claude.json": claudeJson({ linked: { args: ["/links/root"] } }) },
      dirs: ["/v/root"],
      links: { "/links/root": "/v/root" },
    });
    const r = await run({ io, vaults: [{ id: "main", path: "/v/root" }] });
    expect(r.details?.sameRoot).toEqual(["claude-code:linked"]);
  });

  it("skips its own entry when --config= names the config this run loaded", async () => {
    const io = fakeIo({
      files: {
        "/h/cfg.json": "{}",
        "/h/.claude.json": claudeJson({
          "obsidian-tc": { command: "obsidian-tc", args: ["--config=/h/cfg.json", "/v/root"] },
          "obsidian-tc-sp": {
            command: "obsidian-tc",
            args: ["--config", "/h/cfg.json", "/v/root"],
          },
          other: { args: ["/v/root"] },
        }),
      },
      dirs: ["/v/root"],
    });
    const r = await run({
      io,
      vaults: [{ id: "main", path: "/v/root" }],
      configPath: "/h/cfg.json",
    });
    expect(r.details?.sameRoot).toEqual(["claude-code:other"]);
    expect(r.details?.unverifiable).toEqual([]);
  });

  it("puts a Local REST API entry in unverifiable, never sameRoot, and names an enabled REST vault", async () => {
    const io = fakeIo({
      files: {
        "/h/.claude.json": claudeJson({
          rest: {
            command: "npx",
            args: ["/v/root"],
            env: { OBSIDIAN_API_KEY: "secret-key" },
          },
          "rest-port": { args: ["http://127.0.0.1:27124"] },
        }),
      },
      dirs: ["/v/root"],
    });
    const r = await run({
      io,
      vaults: [{ id: "main", path: "/v/root" }],
      restApiOnDisk: () => "enabled",
    });
    expect(r.details?.sameRoot).toEqual([]);
    expect(r.details?.unverifiable).toHaveLength(2);
    expect(r.details?.unverifiable?.[0]).toContain("claude-code:rest");
    expect(r.details?.unverifiable?.[0]).toContain("Local REST API, vault not comparable");
    expect(r.details?.unverifiable?.[0]).toContain("main");
    expect(r.remediation).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("secret-key");
  });

  it("reports another obsidian-tc instance with a different --config as unverifiable", async () => {
    const io = fakeIo({
      files: {
        "/h/other.json": "{}",
        "/h/.claude.json": claudeJson({
          "obsidian-tc-b": { command: "obsidian-tc", args: ["--config", "/h/other.json"] },
        }),
      },
    });
    const r = await run({ io, vaults: [{ id: "main", path: "/v/root" }] });
    expect(r.details?.sameRoot).toEqual([]);
    expect(r.details?.unverifiable).toEqual([
      "claude-code:obsidian-tc-b: another obsidian-tc instance, roots not compared",
    ]);
  });

  it("notes a malformed config by client label, never by path, and stays ok", async () => {
    const io = fakeIo({
      files: {
        "/h/.claude.json": claudeJson({ clean: { args: ["/other"] } }),
        "/w/proj/.cursor/mcp.json": '{ "mcpServers": {',
      },
    });
    const r = await run({ io, vaults: [{ id: "main", path: "/v/root" }] });
    expect(r.status).toBe("ok");
    expect(r.notes?.some((n) => n.includes("cursor"))).toBe(true);
    expect(JSON.stringify(r)).not.toContain("/w/proj");
  });

  it("notes an unreadable config and keeps comparing the others", async () => {
    const io = fakeIo({
      files: { "/h/.claude.json": claudeJson({ hit: { args: ["/v/root"] } }) },
      dirs: ["/v/root"],
      throws: ["/h/.claude.json"],
    });
    const r = await run({ io, vaults: [{ id: "main", path: "/v/root" }] });
    expect(r.status).toBe("ok");
    expect(r.notes?.some((n) => n.includes("claude-code"))).toBe(true);
    expect(r.details?.sameRoot).toEqual([]);
  });

  it("matches case-insensitively on win32", async () => {
    const io = fakeIo(
      {
        files: {
          "C:\\Users\\op\\.claude.json": claudeJson({
            "vault-srv": { args: ["C:\\VAULT\\Root\\notes"] },
          }),
        },
        dirs: ["c:\\vault\\root", "C:\\VAULT\\Root\\notes"],
      },
      { home: "C:\\Users\\op", cwd: "C:\\work\\proj", platform: "win32" },
    );
    const r = await run({ io, vaults: [{ id: "main", path: "c:\\vault\\root" }] });
    expect(r.details?.sameRoot).toEqual(["claude-code:vault-srv"]);
  });

  it("does not fold case on linux", async () => {
    const io = fakeIo({
      files: { "/h/.claude.json": claudeJson({ srv: { args: ["/VAULT/Root/notes"] } }) },
      dirs: ["/VAULT/Root/notes", "/vault/root"],
    });
    const r = await run({ io, vaults: [{ id: "main", path: "/vault/root" }] });
    expect(r.details?.sameRoot).toEqual([]);
  });

  // ---- review fix round on 825ae7c4 (Opus review): one red test per numbered item ----

  it("HIGH: the zero-config invocation `obsidian-tc <vault>` is this server, not a duplicate", async () => {
    const r = await scanClaude({
      mcpServers: { "mcp-obsidian": { command: "npx", args: ["-y", "obsidian-tc", "/v/root"] } },
    });
    expect(r.details).toEqual({ sameRoot: [], unverifiable: [], scanned: ["claude-code"] });
  });

  it("HIGH: a bare doctor's own --config entry is skipped when the run passes its resolved config", async () => {
    const io = fakeIo({
      files: {
        "/h/cfg.json": "{}",
        "/h/.claude.json": claudeJson({
          "obsidian-tc": { command: "obsidian-tc", args: ["--config", "/h/cfg.json"] },
        }),
      },
    });
    const r = await run({
      io,
      vaults: [{ id: "main", path: "/v/root" }],
      configPath: "/h/cfg.json",
    });
    expect(r.details?.unverifiable).toEqual([]);
  });

  describe("doctor CLI wiring: the self-exclusion config is the RESOLVED config file", () => {
    it("run_doctor passes configFilePath (the file it loaded), not the raw --config argument", () => {
      const src = readFileSync(new URL("../src/cli/commands/doctor.ts", import.meta.url), "utf8");
      const anchorAt = src.indexOf("sameVaultRoot: {");
      expect(anchorAt, "doctor.ts builds a sameVaultRoot view").toBeGreaterThanOrEqual(0);
      expect(src.slice(anchorAt, anchorAt + 400)).toContain("configPath: configFilePath,");
    });
  });

  it("MEDIUM: never hands a UNC, device or //host candidate to realpath on win32", async () => {
    const seen: string[] = [];
    const io = fakeIo(
      {
        files: {
          "C:\\Users\\op\\.claude.json": claudeJson({
            unc: { args: ["\\\\host\\share\\notes"] },
            device: { args: ["\\\\.\\pipe\\x"] },
            slashes: { args: ["//host/share/notes"] },
          }),
        },
      },
      {
        home: "C:\\Users\\op",
        cwd: "C:\\work\\proj",
        platform: "win32",
        realpath: (p) => {
          seen.push(p);
          return undefined;
        },
      },
    );
    const r = await run({ io, vaults: [{ id: "main", path: "c:\\vault\\root" }] });
    expect(seen.filter((p) => /host|pipe/.test(p))).toEqual([]);
    expect(r.details?.sameRoot).toEqual([]);
  });

  it("MEDIUM: never hands a darwin /net/<host> candidate to realpath", async () => {
    const seen: string[] = [];
    const io = fakeIo(
      { files: { "/h/.claude.json": claudeJson({ net: { args: ["/net/host/share/notes"] } }) } },
      {
        platform: "darwin",
        realpath: (p) => {
          seen.push(p);
          return undefined;
        },
      },
    );
    const r = await run({ io, vaults: [{ id: "main", path: "/v/root" }] });
    expect(seen).not.toContain("/net/host/share/notes");
    expect(r.details?.sameRoot).toEqual([]);
  });

  it("MEDIUM: refuses a config that is not a regular file (a FIFO or device) and names the client", async () => {
    const io = fakeIo({
      files: { "/h/.claude.json": claudeJson({ hit: { args: ["/v/root"] } }) },
      dirs: ["/v/root"],
      special: ["/h/.claude.json"],
    });
    const r = await run({ io, vaults: [{ id: "main", path: "/v/root" }] });
    expect(r.status).toBe("ok");
    expect(r.notes?.some((n) => n.startsWith("claude-code") && n.includes("regular file"))).toBe(
      true,
    );
    expect(r.details?.sameRoot).toEqual([]);
  });

  it("MEDIUM: refuses a config over 1 MiB and names the client", async () => {
    const io = fakeIo(
      { files: { "/h/.claude.json": "{}" } },
      {
        readFile: (p) => (p === "/h/.claude.json" ? { kind: "too-large" } : { kind: "absent" }),
      },
    );
    const r = await run({ io, vaults: [{ id: "main", path: "/v/root" }] });
    expect(r.notes?.some((n) => n.startsWith("claude-code") && n.includes("1 MiB"))).toBe(true);
  });

  it("LOW: a server key is sanitised before it reaches any output: no escape sequence, no path", async () => {
    const io = fakeIo({
      files: {
        "/h/.claude.json": claudeJson({
          "\u001b[31mred": { args: ["/v/root"] },
          "/v/root": { args: ["/v/root"] },
        }),
      },
      dirs: ["/v/root"],
    });
    const r = await run({ io, vaults: [{ id: "main", path: "/v/root" }] });
    const rendered = [r.summary, ...(r.details?.sameRoot ?? [])].join("\n");
    expect(rendered).not.toContain("\u001b");
    expect(JSON.stringify(r)).not.toContain("/v/root");
    expect(r.details?.sameRoot).toHaveLength(2);
  });

  it("LOW: a server in both user scope and projects[cwd] is listed once", async () => {
    const r = await scanClaude({
      mcpServers: { srv: { args: ["/v/root"] } },
      projects: { "/w/proj": { mcpServers: { srv: { args: ["/v/root"] } } } },
    });
    expect(r.details?.sameRoot).toEqual(["claude-code:srv"]);
  });

  it("LOW: a config reached twice (cwd is home) is read once, and its server listed once", async () => {
    const reads: string[] = [];
    const base = fakeIo({
      files: { "/h/.cursor/mcp.json": claudeJson({ srv: { args: ["/v/root"] } }) },
      dirs: ["/v/root"],
    });
    const io: SameVaultRootIo = {
      ...base,
      cwd: "/h",
      readFile: (p) => {
        reads.push(p);
        return base.readFile(p);
      },
    };
    const r = await run({ io, vaults: [{ id: "main", path: "/v/root" }] });
    expect(reads.filter((p) => p === "/h/.cursor/mcp.json")).toHaveLength(1);
    expect(r.details?.sameRoot).toEqual(["cursor:srv"]);
  });

  it("LOW: a realpath that is not absolute (a pipe, /proc/self/fd) never matches a root", async () => {
    const io = fakeIo({
      files: { "/h/.claude.json": claudeJson({ piped: { args: ["/proc/self/fd/0"] } }) },
      links: { "/proc/self/fd/0": "pipe:[1]" },
    });
    const r = await run({ io, vaults: [{ id: "main", path: "pipe:[1]" }] });
    expect(r.details?.sameRoot).toEqual([]);
  });

  it("LOW: with no vault roots configured the check says so, with status ok", async () => {
    const io = fakeIo({ files: { "/h/.claude.json": claudeJson({ a: { args: ["/x"] } }) } });
    const r = await run({ io, vaults: [] });
    expect(r.status).toBe("ok");
    expect(r.summary).toBe("no vault roots are configured; nothing to compare");
  });

  it("NIT: the Codex note names the config without a home path", async () => {
    const io = fakeIo({ files: { "/h/.claude.json": claudeJson({ a: { args: ["/x"] } }) } });
    const r = await run({ io, vaults: [{ id: "main", path: "/v/root" }] });
    expect(r.notes).toContain(
      "not read: the Codex config (TOML, not read) and every other MCP client's config",
    );
    expect(r.notes?.join("\n")).not.toContain("~/.codex");
  });

  it("NIT: a projects[cwd] key with a trailing separator is found", async () => {
    const r = await scanClaude({
      projects: { "/w/proj/": { mcpServers: { srv: { args: ["/v/root"] } } } },
    });
    expect(r.details?.sameRoot).toEqual(["claude-code:srv"]);
  });

  it("NIT: a directory named ..foo inside a root still matches", async () => {
    const io = fakeIo({
      files: { "/h/.claude.json": claudeJson({ dots: { args: ["/v/root/..foo"] } }) },
      dirs: ["/v/root", "/v/root/..foo"],
    });
    const r = await run({ io, vaults: [{ id: "main", path: "/v/root" }] });
    expect(r.details?.sameRoot).toEqual(["claude-code:dots"]);
  });

  it("NIT: darwin folds case when it compares a candidate with a root", async () => {
    const io = fakeIo(
      { files: { "/h/.claude.json": claudeJson({ srv: { args: ["/vault/root/notes"] } }) } },
      { platform: "darwin" },
    );
    const withDirs = {
      ...io,
      realpath: (p: string) => (p === "/vault/root/notes" || p === "/Vault/Root" ? p : undefined),
    };
    const r = await run({ io: withDirs, vaults: [{ id: "main", path: "/Vault/Root" }] });
    expect(r.details?.sameRoot).toEqual(["claude-code:srv"]);
  });
});
