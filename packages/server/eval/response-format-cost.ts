// response_format cost eval (GH #1027): the same call answered twice through the real registry, once
// detailed and once concise, counting the characters that land in the agent's context.
//
// Usage: bun eval/response-format-cost.ts [--corpus <dir of .md notes>] [--json <out.json>]
//
// With no --corpus a small synthetic vault is generated. A given --corpus is COPIED to a temp dir
// first: the write tools run against the copy, never against the source. Chars are the length of the
// JSON result payload (structuredContent); tokens are chars/4, the same rough estimate for both arms. One
// representative call per tool, so a row is a typical call, not a distribution; the real-world mix is per-tool call count times these figures.
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FolderAcl } from "../src/acl";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { createPagingDeps } from "../src/mcp/byte-page";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { buildRepresentationManifest } from "../src/search/representation";
import { registerM1Tools } from "../src/tools/m1";
import { registerM2Tools } from "../src/tools/m2";
import { registerM8Tools } from "../src/tools/m8";
import { VaultRegistry } from "../src/vault/registry";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function syntheticVault(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const words =
    "memory practice reading prompt note link idea system cache index vault agent".split(" ");
  for (let i = 0; i < 120; i++) {
    const body = Array.from(
      { length: 40 + (i % 7) * 25 },
      (_, j) => words[(i * 3 + j) % words.length],
    ).join(" ");
    const link = i % 5 === 0 ? ` See [[missing-note-${i}]] and [[note-${(i + 1) % 120}]].` : "";
    const fm = i % 3 === 0 ? `---\ntitle: Note ${i}\ntags:\n  - sample\n---\n` : "";
    writeFileSync(
      join(dir, `note-${i}.md`),
      `${fm}# Note ${i}\n\n${body}.${link}\n\n## Details\n\nmore ${body}\n`,
    );
  }
}

function listNotes(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const e of readdirSync(join(dir, d), { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), join(rel, e.name));
      else if (e.name.endsWith(".md")) out.push(join(rel, e.name));
    }
  };
  walk("", "");
  return out.sort();
}

interface Row {
  tool: string;
  call: string;
  detailed: number;
  concise: number;
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "obtc-rf-cost-"));
  const corpus = flag("--corpus");
  const vaultDir = join(root, "vault");
  if (corpus) cpSync(corpus, vaultDir, { recursive: true });
  else syntheticVault(vaultDir);

  const notes = listNotes(vaultDir);
  if (notes.length < 30) throw new Error(`corpus has ${notes.length} notes; need at least 30`);
  const sizeOf = (p: string): number => readFileSync(join(vaultDir, p), "utf8").length;
  const bySize = [...notes].sort((a, b) => sizeOf(a) - sizeOf(b));
  const median = bySize[Math.floor(bySize.length / 2)] as string;
  const spare = bySize.slice(Math.floor(bySize.length / 2) + 1, Math.floor(bySize.length / 2) + 30);

  const db = await openDatabase(":memory:", 5000);
  provisionCacheDb(db);
  const edb = await openDatabase(":memory:", 5000);
  const migDir = fileURLToPath(new URL("../src/migrations/", import.meta.url));
  runMigrations(
    edb,
    EXPERIENTIAL_MIGRATION_FILES.map((f) => ({
      version: versionOf(f),
      sql: readFileSync(join(migDir, f), "utf8"),
    })),
  );
  const flagsets = [["stale_edit"], ["orphan", "stale_access"], ["duplicate"], []];
  notes.slice(0, 50).forEach((p, i) => {
    edb
      .prepare(
        "INSERT INTO note_quality (vault_id, path, computed_at, flags, quality_score) VALUES (?, ?, ?, ?, ?)",
      )
      .run("v", p, 1_700_000_000_000, JSON.stringify(flagsets[i % flagsets.length]), (i % 10) / 10);
  });

  const vaultRegistry = new VaultRegistry([{ id: "v", path: vaultDir }]);
  const registry = new ToolRegistry({});
  const provider = fakeEmbeddingProvider({ dimensions: 32 });
  registerM1Tools(registry, {
    vaultRegistry,
    version: "eval",
    startedAt: 0,
    embeddings: { provider: "fake", model: "fake" },
    edb,
    paging: createPagingDeps({ secret: "eval", budgetBytes: () => registry.maxResponseBytes }),
  });
  registerM2Tools(registry, {
    vaultRegistry,
    embeddingProvider: provider,
    representation: buildRepresentationManifest(provider, {}),
  });
  registerM8Tools(registry, { edb, now: () => 1_700_000_000_000 });
  const ctx: CallerContext = {
    caller: "eval",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "v",
    db,
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
  };
  const call = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    const r = await registry.dispatch(tool, args, ctx);
    if (!r.ok) throw new Error(`${tool} failed: ${r.error.code}: ${r.error.message}`);
    return r.data;
  };
  const size = (d: unknown): number => JSON.stringify(d).length;

  await call("index_vault", { vault: "v" });
  // Give 20 notes a frontmatter property so find_notes_by_property has real matches.
  for (const p of spare.slice(0, 20))
    await call("update_frontmatter", {
      vault: "v",
      path: p,
      operation: "set",
      key: "status",
      value: "draft",
    });

  const rows: Row[] = [];
  const measure = async (
    tool: string,
    callLabel: string,
    args: (arm: "detailed" | "concise") => Record<string, unknown>,
  ): Promise<void> => {
    const detailed = size(await call(tool, { ...args("detailed"), response_format: "detailed" }));
    const concise = size(await call(tool, { ...args("concise"), response_format: "concise" }));
    rows.push({ tool, call: callLabel, detailed, concise });
  };

  const v = "v";
  await measure("read_note", `median note (${sizeOf(median)} chars on disk)`, () => ({
    vault: v,
    path: median,
  }));
  await measure("read_notes", "5 notes", () => ({ vault: v, paths: spare.slice(0, 5) }));
  await measure("write_note", "create, 1 KB body", (arm) => ({
    vault: v,
    path: `new-${arm}.md`,
    content: "x".repeat(1000),
  }));
  await measure("append_note", "append 200 chars", () => ({
    vault: v,
    path: spare[5],
    content: "y".repeat(200),
  }));
  await measure("patch_note", "append under the preamble", () => ({
    vault: v,
    path: spare[6],
    operation: "append",
    anchor: { type: "frontmatter" },
    content: "patched line",
  }));
  await measure("update_frontmatter", "set one key", () => ({
    vault: v,
    path: spare[7],
    operation: "set",
    key: "reviewed",
    value: true,
  }));
  await measure("find_notes_by_property", "key=status (20 matches)", () => ({
    vault: v,
    key: "status",
  }));
  await measure("find_unresolved_links", "limit 500", () => ({ vault: v, limit: 500 }));
  await measure("search_text", "default limit", () => ({ vault: v, query: "memory" }));
  await measure("search_regex", "default limit", () => ({
    vault: v,
    pattern: "(memory|memories)",
  }));
  await measure("search_semantic", "k=10", () => ({ vault: v, query: "memory practice", k: 10 }));
  await measure("search_jsonlogic", "content contains", () => ({
    vault: v,
    logic: { in: ["memory", { var: "content" }] },
  }));
  await measure("search_vault", "mode=text", () => ({ vault: v, query: "memory", mode: "text" }));
  await measure("note_quality_report", "limit 50", () => ({ vault: v, limit: 50 }));

  const pct = (a: number, b: number): string => `${(((a - b) / a) * 100).toFixed(1)}%`;
  const lines = [
    `corpus: ${corpus ?? "synthetic"} (${notes.length} notes)`,
    "",
    "| tool | call | detailed chars | concise chars | saved | detailed tokens | concise tokens |",
    "|---|---|---:|---:|---:|---:|---:|",
    ...rows.map(
      (r) =>
        `| ${r.tool} | ${r.call} | ${r.detailed} | ${r.concise} | ${pct(r.detailed, r.concise)} | ${Math.ceil(r.detailed / 4)} | ${Math.ceil(r.concise / 4)} |`,
    ),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  const out = flag("--json");
  if (out)
    writeFileSync(
      out,
      JSON.stringify({ corpus: corpus ?? "synthetic", notes: notes.length, rows }, null, 2),
    );
  rmSync(root, { recursive: true, force: true });
}

await main();
// The registry and the in-memory databases keep handles open, so bun would not exit on its own.
process.exit(0);
