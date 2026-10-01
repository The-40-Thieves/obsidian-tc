// tools.defaults.responseFormat through the composition root (`buildServerRuntime`): the only place
// the config and the tool deps meet. A unit test building registerM1Tools itself passes whether or
// not tool-wiring.ts reads the key, so this goes through the real runtime. It also pins that a
// hand-built config lacking `tools` (an embedder bypassing ServerConfigSchema) still wires, and
// gets the shipped default (detailed) rather than a TypeError at startup.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configFromVaultPath } from "../src/cli/args";
import { provisionCacheDb } from "../src/db/provision";
import { buildServerRuntime } from "../src/runtime/server-runtime";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const dirs: string[] = [];
const tmp = (p: string): string => {
  const d = makeTempDir(p);
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      /* a still-open sqlite handle can make Windows refuse the unlink; the assertions have run */
    }
  }
});

type Shape = "default" | "concise" | "detailed" | "no-tools" | "no-defaults";

async function readNoteWith(shape: Shape, args: Record<string, unknown> = {}) {
  const vaultDir = tmp("otc-rf-vault-");
  writeFileSync(join(vaultDir, "n.md"), "---\ntags: [a]\n---\n# N\n\nbody text\n");
  const config = configFromVaultPath(vaultDir);
  config.cacheDir = tmp("otc-rf-cache-");
  const loose = config as unknown as { tools?: { defaults?: unknown } };
  if (shape === "concise" || shape === "detailed") config.tools.defaults.responseFormat = shape;
  if (shape === "no-tools") delete loose.tools;
  if (shape === "no-defaults") delete loose.tools?.defaults;
  const runtime = await buildServerRuntime(config, join(vaultDir, "config.json"));
  try {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const ctx = {
      caller: "test",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "main",
      db,
    };
    const r = await runtime.registry.dispatch(
      "read_note",
      { vault: "main", path: "n.md", ...args },
      ctx as never,
    );
    return (r as { data: Record<string, unknown> }).data;
  } finally {
    await runtime.close("test cleanup");
  }
}

describe("tools.defaults.responseFormat at the composition root", () => {
  it("shipped default is detailed: the frontmatter is returned", async () => {
    const d = await readNoteWith("default");
    expect(d.frontmatter).toEqual({ tags: ["a"] });
  });

  it("concise config default is honoured by a call naming no format", async () => {
    const d = await readNoteWith("concise");
    expect("frontmatter" in d).toBe(false);
    expect(d.body).toContain("body text");
  });

  it("an explicit response_format beats the config default", async () => {
    const d = await readNoteWith("concise", { response_format: "detailed" });
    expect(d.frontmatter).toEqual({ tags: ["a"] });
  });

  it("a hand-built config lacking `tools` wires and behaves as detailed", async () => {
    const d = await readNoteWith("no-tools");
    expect(d.frontmatter).toEqual({ tags: ["a"] });
  });

  it("a hand-built config lacking `tools.defaults` wires and behaves as detailed", async () => {
    const d = await readNoteWith("no-defaults");
    expect(d.frontmatter).toEqual({ tags: ["a"] });
  });
});
