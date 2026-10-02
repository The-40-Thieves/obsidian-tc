// Build the template vault + warm cache once; every run copies both, so each trial starts from the
// same bytes and a pre-built index (no embedding work competes with the client's calls).
//
// Usage: bun eval/write-ergonomics/template.ts <root> [--corpus <dir>] [--omit rel/path.md,other.md]
import { cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeConfig } from "./config";
import { buildVault, MEMORY_ENTITY } from "./fixtures";

export const DEFAULT_CORPUS = "/data/obsidian-tc-eval/evergreen-corpus";
const CLI = resolve(import.meta.dirname, "../../dist/cli.js");

/** Spawn the built server directly (no proxy) with the same stdio transport the clients use. */
export async function withServer<T>(
  config: string,
  fn: (call: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [CLI, "serve", config],
    stderr: "ignore",
  });
  const client = new Client({ name: "write-ergonomics-template", version: "1" }, {});
  await client.connect(transport);
  try {
    return await fn(async (name, args) => {
      const r = await client.callTool({ name: "call_capability", arguments: { name, args } });
      if (r.isError)
        throw new Error(`${name} failed: ${JSON.stringify(r.structuredContent ?? r.content)}`);
      return r.structuredContent;
    });
  } finally {
    await client.close();
  }
}

/** The cache records the vault's absolute path, so every trial's vault lives at the SAME path
 *  (<root>/live) and is renamed into its run dir afterwards. The template is built there too. */
export const livePaths = (root: string) => ({
  dir: join(root, "live"),
  vault: join(root, "live", "vault"),
  cache: join(root, "live", "cache"),
  config: join(root, "live", "config.json"),
});

export async function buildTemplate(
  root: string,
  corpus = DEFAULT_CORPUS,
  omit: readonly string[] = [],
): Promise<void> {
  const tpl = join(root, "template");
  const live = livePaths(root);
  if (existsSync(tpl) || existsSync(live.dir))
    throw new Error(`${tpl} or ${live.dir} exists; the template is immutable once built`);
  buildVault(live.vault, corpus, omit);
  mkdirSync(live.cache, { recursive: true });
  writeConfig(live.config, "main", live.vault, live.cache);
  await withServer(live.config, async (call) => {
    await call("create_entity", {
      vault: "main",
      name: MEMORY_ENTITY.name,
      type: MEMORY_ENTITY.type,
      observations: MEMORY_ENTITY.observations,
      materialize: true,
    });
    // Let the startup reconcile finish (it ends "ok" or "degraded") so the copied cache is warm.
    for (let i = 0; i < 180; i++) {
      const st = (await call("get_index_status", {}).catch(() => undefined)) as
        | { reconcile?: string; notes_ready?: boolean }
        | undefined;
      if (
        st?.notes_ready &&
        st.reconcile !== undefined &&
        !/^(pending|running|in_progress)$/.test(st.reconcile)
      )
        break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  });
  mkdirSync(tpl, { recursive: true });
  cpSync(live.vault, join(tpl, "vault"), { recursive: true });
  cpSync(live.cache, join(tpl, "cache"), { recursive: true });
  writeFileSync(join(tpl, "BUILT.txt"), `${new Date().toISOString()}\n`);
  renameSync(live.dir, join(root, "template-build-scratch"));
}

export function copyTemplate(root: string): void {
  const live = livePaths(root);
  if (existsSync(live.dir))
    throw new Error(`${live.dir} exists: a previous trial was not archived`);
  mkdirSync(live.dir, { recursive: true });
  cpSync(join(root, "template", "vault"), live.vault, { recursive: true });
  cpSync(join(root, "template", "cache"), live.cache, { recursive: true });
}

if ((import.meta as unknown as { main?: boolean }).main) {
  const argv = process.argv.slice(2);
  const root = argv[0];
  if (!root)
    throw new Error("usage: bun eval/write-ergonomics/template.ts <root> [--corpus <dir>]");
  const ci = argv.indexOf("--corpus");
  const oi = argv.indexOf("--omit");
  buildTemplate(
    resolve(root),
    ci >= 0 ? argv[ci + 1] : DEFAULT_CORPUS,
    oi >= 0 ? (argv[oi + 1] ?? "").split(",") : [],
  ).then(
    () => process.stdout.write(`template built under ${root}/template\n`),
    (e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
