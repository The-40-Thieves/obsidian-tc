// Operator-written path globs with backslashes (`Private\**`, the natural spelling on Windows).
// Checked vault paths are always forward-slash (normalizeVaultPath splits on [\\/]+), so a glob that
// kept its backslashes matched NOTHING. For a whitelist (readPaths/writePaths/deletePaths) that
// fails closed, which is safe; for a RESTRICTION (egress.excludePaths, ACL rules, index.excludePaths)
// it failed OPEN and said so nowhere. The fix lives at config load, in the one shared path-glob
// schema every such field uses. These tests drive the REAL schema (ServerConfigSchema), then the
// real consumers, so a field that forgets the shared schema fails here.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
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
