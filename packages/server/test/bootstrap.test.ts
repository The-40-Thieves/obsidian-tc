// THE-101: session_bootstrap triage + config-driven context load. The routing table is injected
// (never baked into the tree), so these assertions exercise the mechanism against a small synthetic
// table and a temp vault.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootstrapTools } from "../src/tools/m5/bootstrap-tools";
import { VaultRegistry } from "../src/vault/registry";

const bootstrap = {
  deepPaths: ["CLAUDE.md", "missing.md"],
  domains: [
    { name: "music", signals: ["suno", "mixing"], paths: ["domain/music.md"] },
    { name: "dev", signals: ["typescript", "deploy"], paths: ["domain/dev.md"] },
    { name: "health", signals: ["labs"], paths: ["domain/health.md"] },
  ],
  maxPaths: 10,
  deepPhrases: ["catch me up"],
};

describe("THE-101 session_bootstrap", () => {
  const root = mkdtempSync(join(tmpdir(), "obtc-bootstrap-"));
  const tool: any = buildBootstrapTools({
    vaultRegistry: new VaultRegistry([{ id: "t", name: "t", path: root }]),
    bootstrap,
  } as never)[0];
  const ctx = {
    acl: undefined,
    caller: null,
    authenticated: true,
    grantedScopes: new Set<string>(),
    vaultId: "t",
  };
  const run = (message: string, mode = "auto") => tool.handler({ vault: "t", message, mode }, ctx);

  beforeAll(() => {
    mkdirSync(join(root, "domain"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "---\ntype: config\n---\ninstructions");
    writeFileSync(join(root, "domain", "music.md"), "music domain");
    writeFileSync(join(root, "domain", "dev.md"), "dev domain");
    writeFileSync(join(root, "domain", "health.md"), "health domain");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("is lightweight with no signal and no catch-up phrase", () => {
    const r = run("convert 14 lufs to dbfs");
    expect(r.mode).toBe("lightweight");
    expect(r.loaded).toHaveLength(0);
    expect(r.matched_domains).toEqual([]);
  });

  it("is standard on a single domain signal, loading that domain's paths", () => {
    const r = run("help me with suno mastering");
    expect(r.mode).toBe("standard");
    expect(r.matched_domains).toEqual(["music"]);
    expect(r.loaded.map((n: { path: string }) => n.path)).toEqual(["domain/music.md"]);
  });

  it("is deep on a catch-up phrase; loads deepPaths, parses frontmatter, skips a missing one", () => {
    const r = run("catch me up");
    expect(r.mode).toBe("deep");
    expect(r.loaded.map((n: { path: string }) => n.path)).toEqual(["CLAUDE.md"]);
    expect(r.loaded[0].frontmatter).toEqual({ type: "config" });
    expect(r.skipped).toContainEqual({ path: "missing.md", reason: "not_found" });
  });

  it("is deep when 3+ domains match", () => {
    expect(run("suno typescript labs").mode).toBe("deep");
  });

  it("lets an explicit mode override auto triage", () => {
    const r = run("", "deep");
    expect(r.mode).toBe("deep");
    expect(r.loaded.map((n: { path: string }) => n.path)).toEqual(["CLAUDE.md"]);
  });
});
