// The config examples this docs set adds must load through the real loader. The loader reads JSON
// only, and a recipe without cacheDir or transports.http.allowedHosts refuses to boot or 403s every
// request, so each block is read back from the page and loaded from a file, not trusted as prose.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load";
import { makeTempDir, rmTemp } from "./tmp";

const docs = fileURLToPath(new URL("../../../docs/src/content/docs/", import.meta.url));
const page = (rel: string) => readFileSync(join(docs, rel), "utf8");
// Indented fences are list-item blocks; their lines keep the indent, which JSON allows.
const jsonBlocks = (md: string) =>
  [...md.matchAll(/^[ \t]*```json\n([\s\S]*?)^[ \t]*```$/gm)].map((m) => m[1] ?? "");
// The text after `marker` up to the next heading, so a block from a later section is never picked.
const sectionAfter = (rel: string, marker: string) =>
  (page(rel).split(marker)[1] ?? "").split(/^#{2,3} /m)[0] ?? "";

// The placeholders the pages print; a deployment substitutes its own values.
const PLACEHOLDERS: Record<string, string> = {
  "<authkit-domain>": "example-authkit.authkit.app",
  "<realm>": "vault",
};

const clientRecipes = page("deployment/client-recipes.md");
const examples = [
  ...jsonBlocks(clientRecipes)
    .filter((b) => b.includes('"auth"'))
    .map((block, i) => ({ name: `client-recipes #${i + 1}`, block })),
  ...jsonBlocks(sectionAfter("security/auth-model.md", "### Turning it on"))
    .slice(0, 1)
    .map((block) => ({ name: "auth-model Turning it on", block })),
  ...jsonBlocks(sectionAfter("configuration/config-yaml.md", "A minimal example"))
    .slice(0, 1)
    .map((block) => ({ name: "config-yaml minimal example", block })),
];

describe("docs config examples", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmTemp(d);
  });

  it("the recipes page carries no YAML fence, and every example this docs set adds is found", () => {
    expect(clientRecipes).not.toMatch(/^```yaml/m);
    // Floor: a broken read must not pass with zero examples.
    expect(examples.length).toBeGreaterThanOrEqual(4);
  });

  it.each(examples)("$name loads through loadConfig", ({ block }) => {
    let text = block;
    for (const [from, to] of Object.entries(PLACEHOLDERS)) text = text.split(from).join(to);
    expect(text).not.toMatch(/<[a-z-]+>/);

    const cfg = JSON.parse(text) as {
      cacheDir?: string;
      transports?: { http?: { allowedHosts?: string[] } };
      auth?: {
        mode?: string;
        requireJti?: boolean;
        scopesSupported?: string[];
        oidc?: { claimMapping?: unknown };
      };
    };
    expect(cfg.cacheDir).toBeTruthy();
    expect(cfg.transports?.http?.allowedHosts?.length).toBeGreaterThan(0);
    expect(cfg.auth?.requireJti).toBe(true);
    if (cfg.auth?.mode === "oidc") {
      expect(cfg.auth.scopesSupported?.length).toBeGreaterThan(0);
      expect(cfg.auth.oidc?.claimMapping).toBeDefined();
    }

    const dir = makeTempDir("docs-config-example-");
    dirs.push(dir);
    const file = join(dir, "config.json");
    writeFileSync(file, text);
    expect(() => loadConfig(file)).not.toThrow();
  });
});
