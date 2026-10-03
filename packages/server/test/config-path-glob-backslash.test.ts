// Operator-written path globs with backslashes (`Private\**`, the natural spelling on Windows).
// Checked vault paths are always forward-slash (normalizeVaultPath splits on [\\/]+), so a glob that
// kept its backslashes matched NOTHING. For a whitelist (readPaths/writePaths/deletePaths) that
// fails closed, which is safe; for a RESTRICTION (egress.excludePaths, ACL rules, index.excludePaths)
// it failed OPEN and said so nowhere. The fix lives at config load, in the one shared path-glob
// schema every such field uses. These tests drive the REAL schema (ServerConfigSchema), then the
// real consumers, so a field that forgets the shared schema fails here.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { resolveServeConfigWithProvenance } from "../src/cli/resolve-config";
import { createEmbeddingProvider } from "../src/embeddings";
import type { FetchFn } from "../src/embeddings/http";
import {
  assertSourcePathsAllowed,
  compileEgressFilter,
  EgressViolationError,
  isExcludedPath,
} from "../src/plane/egress-filter";
import { compileExclusionEntries } from "../src/search/index-exclusion";
import { evaluatePathAcl, pathScopesSatisfied } from "../src/vault/acl-path";
import { makeTempDir, rmTemp } from "./tmp";

const parse = (over: Record<string, unknown>) =>
  ServerConfigSchema.parse({ vaults: [{ id: "v", path: "/tmp/vault" }], ...over });

describe("egress.excludePaths with backslashes (fail-open restriction)", () => {
  it('"Private\\\\**" is normalised at load and excludes Private/x.md from the embedding request', async () => {
    const cfg = parse({ egress: { excludePaths: ["Private\\**"] } });
    expect(cfg.egress.excludePaths).toEqual(["Private/**"]);
    const filter = compileEgressFilter(cfg.egress.excludePaths);
    const fetchFn = (async () =>
      new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as FetchFn;
    const provider = createEmbeddingProvider(
      { provider: "ollama", model: "nomic-embed-text", dimensions: 2 },
      { fetchFn, excludeFilter: filter },
    );
    expect(isExcludedPath(filter, "Private/x.md")).toBe(true);
    expect(() => assertSourcePathsAllowed(filter, "embed", ["Private/x.md"])).toThrow(
      EgressViolationError,
    );
    await expect(
      provider.embed(["text"], { input: "document", sourcePaths: ["Private/x.md"] }),
    ).rejects.toBeInstanceOf(EgressViolationError);
    await expect(
      provider.embed(["text"], { input: "document", sourcePaths: ["Public/x.md"] }),
    ).resolves.toBeDefined();
  });

  it("a folder spelled with a trailing or leading backslash is the same exclusion as the slash form", () => {
    for (const spelled of ["Private\\", "Private\\\\", "\\Private", ".\\Private"]) {
      const cfg = parse({ egress: { excludePaths: [spelled] } });
      const filter = compileEgressFilter(cfg.egress.excludePaths);
      expect(isExcludedPath(filter, "Private/x.md"), spelled).toBe(true);
      expect(isExcludedPath(filter, "Public/x.md"), spelled).toBe(false);
    }
  });

  it("a pattern that is only backslashes still normalises to nothing and is refused", () => {
    expect(
      ServerConfigSchema.safeParse({
        vaults: [{ id: "v", path: "/tmp/vault" }],
        egress: { excludePaths: ["\\"] },
      }).success,
    ).toBe(false);
  });
});

describe("acl rules with backslashes (fail-open restriction)", () => {
  it("a scope rule `notes\\private\\**` gates notes/private/a.md", () => {
    const cfg = parse({
      acl: { rules: [{ glob: "notes\\private\\**", scopes: ["admin:private"] }] },
    });
    expect(cfg.acl.rules[0]?.glob).toBe("notes/private/**");
    const acl = new FolderAcl(cfg.acl);
    expect(acl.scopesForPath("notes/private/a.md")).toEqual(["admin:private"]);
    expect(pathScopesSatisfied(acl, "notes/private/a.md", ["read:notes"])).toBe(false);
    expect(pathScopesSatisfied(acl, "notes/private/a.md", ["admin:private"])).toBe(true);
    expect(pathScopesSatisfied(acl, "notes/public/a.md", ["read:notes"])).toBe(true);
  });

  it("the same holds for a per-vault acl block", () => {
    const cfg = ServerConfigSchema.parse({
      vaults: [
        {
          id: "v",
          path: "/tmp/vault",
          acl: { rules: [{ glob: "notes\\private\\**", scopes: ["admin:private"] }] },
        },
      ],
    });
    expect(cfg.vaults[0]?.acl?.rules[0]?.glob).toBe("notes/private/**");
  });
});

describe("acl whitelists with backslashes", () => {
  it('readPaths: ["notes\\\\**"] behaves identically to ["notes/**"]', () => {
    const win = new FolderAcl(parse({ acl: { readPaths: ["notes\\**"] } }).acl);
    const fwd = new FolderAcl(parse({ acl: { readPaths: ["notes/**"] } }).acl);
    for (const p of ["notes/a.md", "notes/deep/b.md", "other/c.md", "notesx/d.md"]) {
      expect(evaluatePathAcl(win, "read", p), p).toEqual(evaluatePathAcl(fwd, "read", p));
    }
    expect(evaluatePathAcl(win, "read", "notes/a.md").allowed).toBe(true);
    expect(win.readPaths).toEqual(["notes/**"]);
  });

  it("writePaths and deletePaths are normalised the same way, duplicate separators collapse", () => {
    const cfg = parse({
      acl: { writePaths: ["notes\\\\drafts\\**"], deletePaths: ["notes//drafts/**"] },
    });
    expect(cfg.acl.writePaths).toEqual(["notes/drafts/**"]);
    expect(cfg.acl.deletePaths).toEqual(["notes/drafts/**"]);
  });
});

describe("vaults[].index.excludePaths with backslashes (Obsidian prefix dialect)", () => {
  it("a backslash prefix excludes the same notes as the slash prefix", () => {
    const cfg = ServerConfigSchema.parse({
      vaults: [{ id: "v", path: "/tmp/vault", index: { excludePaths: ["Archive\\", "\\Old\\"] } }],
    });
    const entries = cfg.vaults[0]?.index?.excludePaths ?? [];
    expect(entries).toEqual(["Archive/", "Old/"]);
    const { test } = compileExclusionEntries(entries);
    expect(test("Archive/a.md")).toBe(true);
    expect(test("Old/a.md")).toBe(true);
    expect(test("Keep/a.md")).toBe(false);
  });

  it("a /regex/ entry is NOT touched: a backslash there is a regex escape", () => {
    const cfg = ServerConfigSchema.parse({
      vaults: [{ id: "v", path: "/tmp/vault", index: { excludePaths: ["/^Daily\\/\\d+/"] } }],
    });
    expect(cfg.vaults[0]?.index?.excludePaths).toEqual(["/^Daily\\/\\d+/"]);
  });
});

// Security review round: an ACL pattern is matched against ROOTLESS vault-relative paths
// (`Private/x.md`), so a pattern that stays root-marked after normalisation (`\Private\**` ->
// `/Private/**`, `C:\notes\**`, `\\server\share`) can never match. For `acl.rules` that fails OPEN:
// the rule's extra scopes are bypassed. Stripping the marker would turn an inert whitelist entry
// into a grant, so config load REFUSES it instead (egress/index fields keep their strip/widen).
describe("ACL patterns that stay root-marked or end in a separator are refused at load", () => {
  const refused = (over: Record<string, unknown>, message: RegExp) => {
    const r = ServerConfigSchema.safeParse({ vaults: [{ id: "v", path: "/tmp/vault" }], ...over });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.message).join("\n")).toMatch(message);
  };
  const rule = (glob: string) => ({ acl: { rules: [{ glob, scopes: ["admin:private"] }] } });

  it.each([
    ["\\Private\\**", "Private/**"],
    ["/Private/**", "Private/**"],
    ["//Private/**", "Private/**"],
    ["\\\\server\\share\\**", "server/share/**"],
    ["C:\\notes\\**", "notes/**"],
    ["c:/notes/**", "notes/**"],
    ["./Private/**", "Private/**"],
    [".\\Private\\**", "Private/**"],
  ])("acl.rules[].glob %j is refused, suggesting the vault-relative %j", (glob, hint) => {
    refused(rule(glob), new RegExp(`vault-relative.*"${hint.replace(/[*/]/g, "\\$&")}"`));
  });

  it("each of readPaths / writePaths / deletePaths refuses a root-marked entry, root and per vault", () => {
    for (const key of ["readPaths", "writePaths", "deletePaths"]) {
      refused({ acl: { [key]: ["C:\\notes\\**"] } }, /vault-relative/);
      refused({ acl: { [key]: ["/notes/**"] } }, /vault-relative/);
      const perVault = ServerConfigSchema.safeParse({
        vaults: [{ id: "v", path: "/tmp/vault", acl: { [key]: ["\\notes\\**"] } }],
      });
      expect(perVault.success, `vaults[].acl.${key}`).toBe(false);
    }
    const perVaultRule = ServerConfigSchema.safeParse({
      vaults: [
        {
          id: "v",
          path: "/tmp/vault",
          acl: { rules: [{ glob: "\\Private\\**", scopes: ["admin:private"] }] },
        },
      ],
    });
    expect(perVaultRule.success).toBe(false);
  });

  it("a trailing separator is refused with a hint to use `/**` (it would be an exact `x/` that matches nothing)", () => {
    refused(rule("notes\\private\\"), /notes\/private\/\*\*/);
    refused(rule("notes/private/"), /notes\/private\/\*\*/);
    refused({ acl: { readPaths: ["notes\\private\\"] } }, /notes\/private\/\*\*/);
  });

  it("valid vault-relative patterns, with and without backslashes, still load and match", () => {
    const cfg = parse({
      acl: {
        rules: [
          { glob: "Private\\**", scopes: ["admin:private"] },
          { glob: "notes/secret/**", scopes: ["admin:secret"] },
          { glob: "**/*.secret.md", scopes: ["admin:secret"] },
        ],
        readPaths: ["notes\\**", "root.md", "**"],
        writePaths: ["notes\\drafts\\**"],
        deletePaths: ["notes/drafts/**"],
      },
    });
    expect(cfg.acl.rules.map((r) => r.glob)).toEqual([
      "Private/**",
      "notes/secret/**",
      "**/*.secret.md",
    ]);
    const acl = new FolderAcl(cfg.acl);
    expect(acl.scopesForPath("Private/x.md")).toEqual(["admin:private"]);
    expect(pathScopesSatisfied(acl, "Private/x.md", ["read:notes"])).toBe(false);
    expect(pathScopesSatisfied(acl, "Private/x.md", ["admin:private"])).toBe(true);
    expect(evaluatePathAcl(acl, "write", "notes/drafts/a.md").allowed).toBe(true);
  });

  // Round 2 (Codex spot-check): runtime paths reject `..` and drop `.` segments (vault/paths.ts), so
  // a rule spelled with one never matches the path it names: a fail-open for `acl.rules`.
  it.each([
    "../Private/**",
    "Private/./**",
    "Private/../**",
    "Private\\..\\**",
    "Private/.",
    "Private/..",
    "a/b/../../Private/**",
    "**/../x.md",
  ])("a `.` or `..` path segment is refused: %j", (glob) => {
    refused(rule(glob), /"\.\.?" path segment/);
    refused({ acl: { readPaths: [glob] } }, /path segment/);
    refused({ acl: { writePaths: [glob] } }, /path segment/);
    refused({ acl: { deletePaths: [glob] } }, /path segment/);
    const perVault = ServerConfigSchema.safeParse({
      vaults: [{ id: "v", path: "/tmp/vault", acl: { rules: [{ glob, scopes: ["admin:x"] }] } }],
    });
    expect(perVault.success, `vaults[].acl.rules ${glob}`).toBe(false);
  });

  it.each([
    ["a\u0000b/**", "NUL"],
    ["Private/\u0000**", "NUL"],
    ["Pri\u0001vate/**", "control"],
    ["Private/\u001f**", "control"],
    ["Private\u007f/**", "control"],
    ["Private\n/**", "control"],
    ["Private\t/**", "control"],
    ["Private\u0085/**", "control"],
  ])("a control character (NUL included) is refused: %j", (glob) => {
    refused(rule(glob), /control character/);
    refused({ acl: { readPaths: [glob] } }, /control character/);
  });

  it("dot-led and dotted names that are not a bare `.`/`..` segment still load", () => {
    const cfg = parse({
      acl: {
        rules: [
          { glob: ".obsidian/**", scopes: ["admin:cfg"] },
          { glob: "notes/.hidden/**", scopes: ["admin:cfg"] },
          { glob: "a..b/**", scopes: ["admin:cfg"] },
          { glob: "...", scopes: ["admin:cfg"] },
          { glob: "**/.git/**", scopes: ["admin:cfg"] },
          { glob: "v1.2/**", scopes: ["admin:cfg"] },
        ],
      },
    });
    expect(cfg.acl.rules).toHaveLength(6);
  });

  it("egress and index fields keep their strip/widen behaviour (not refused)", () => {
    expect(parse({ egress: { excludePaths: ["\\Private\\"] } }).egress.excludePaths).toEqual([
      "/Private/",
    ]);
    const cfg = ServerConfigSchema.parse({
      vaults: [{ id: "v", path: "/tmp/vault", index: { excludePaths: ["\\Old\\"] } }],
    });
    expect(cfg.vaults[0]?.index?.excludePaths).toEqual(["Old/"]);
  });

  it("the refusal reaches `doctor` / `serve` as a CliError naming the file and the ACL field", () => {
    const dir = makeTempDir("otc-acl-root-glob-");
    try {
      const file = join(dir, "c.json");
      writeFileSync(
        file,
        JSON.stringify({
          vaults: [{ id: "v", path: dir }],
          acl: { rules: [{ glob: "\\Private\\**", scopes: ["admin:private"] }] },
        }),
      );
      expect(() => resolveServeConfigWithProvenance(file)).toThrow(
        new RegExp(
          `${file.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} is not a valid config: .*acl\\.rules\\.0\\.glob.*Private/\\*\\*`,
        ),
      );
    } finally {
      rmTemp(dir);
    }
  });
});
