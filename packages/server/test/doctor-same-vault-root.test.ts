// clients.sameVaultRoot doctor check: does another MCP server in an MCP client config point at a
// configured vault root? Every filesystem input is injected (readFile/realpath/home/cwd/platform),
// so no real home directory is read and the same cases run on every OS.
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
      return files[p];
    },
    realpath: (p) => links[p] ?? (existing.has(p) ? p : undefined),
    ...over,
  };
}

const claudeJson = (mcpServers: unknown) => JSON.stringify({ mcpServers });

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
});
