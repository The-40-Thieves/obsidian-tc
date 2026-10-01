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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BootstrapConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { FolderAcl } from "../src/acl";
import { CapabilityCache } from "../src/bridge";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { createPagingDeps } from "../src/mcp/byte-page";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { buildResourceUri } from "../src/mcp/resources";
import { buildRepresentationManifest } from "../src/search/representation";
import { registerM1Tools } from "../src/tools/m1";
import { registerM2Tools } from "../src/tools/m2";
import { registerM3Tools } from "../src/tools/m3";
import { registerM4Tools } from "../src/tools/m4";
import { registerM5Tools } from "../src/tools/m5";
import { registerM7Tools } from "../src/tools/m7";
import { registerM8Tools } from "../src/tools/m8";
import { VaultRegistry } from "../src/vault/registry";
import { captureSnapshot } from "../src/vault/snapshots";
import { appendTrace, resolveTraceAbs } from "../src/workspace/sessions";

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

// test/tmp.ts's makeTempDir registers a vitest hook and cannot load under bun, so this script owns
// its scratch dir: removed in a finally, so a throw mid-run does not leave it in /tmp.
async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "obtc-rf-cost-"));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function run(root: string): Promise<void> {
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

  const docsDir = join(root, "docs-vault");
  mkdirSync(docsDir, { recursive: true });
  const cacheDir = join(root, "cache");
  mkdirSync(cacheDir, { recursive: true });
  const vaultRegistry = new VaultRegistry([
    { id: "v", path: vaultDir },
    { id: "docs", path: docsDir, kind: "docs" },
  ]);
  const registry = new ToolRegistry({ verifyElicit: elicitVerifier });
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
  registerM3Tools(registry, { vaultRegistry });
  // The bundle tools never open the Obsidian bridge: an empty capability cache and no client do.
  registerM4Tools(registry, {
    vaultRegistry,
    capabilities: new CapabilityCache(),
    bridgeFor: () => undefined,
  });
  registerM5Tools(registry, {
    cacheDir,
    vaultRegistry,
    memoryFolder: () => "memory",
    traceFolder: () => ".obsidian-tc/traces",
    bootstrap: BootstrapConfigSchema.parse({ deepPaths: spare.slice(10, 15) }),
  });
  registerM7Tools(registry, {
    vaultRegistry,
    embeddingProvider: provider,
    reranker: null,
    roles: null,
    classRouter: true,
    edb,
  });
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

  // Part 2. A note with many outgoing links and the most-linked-to note, found by scanning the
  // first 80 notes, so the link rows measure a real call rather than an empty list.
  let linkiest = median;
  let linkiestCount = -1;
  const inbound = new Map<string, number>();
  for (const p of notes.slice(0, 80)) {
    const out = (await call("get_outgoing_links", {
      vault: v,
      path: p,
      response_format: "detailed",
    })) as { links: Array<{ target_path?: string | null }> };
    if (out.links.length > linkiestCount) {
      linkiest = p;
      linkiestCount = out.links.length;
    }
    for (const l of out.links)
      if (l.target_path) inbound.set(l.target_path, (inbound.get(l.target_path) ?? 0) + 1);
  }
  const mostLinked = [...inbound.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? median;
  await measure("read_frontmatter", "median note", () => ({ vault: v, path: median }));
  await measure("get_outgoing_links", `${linkiestCount} links`, () => ({
    vault: v,
    path: linkiest,
  }));
  await measure("get_backlinks", `${inbound.get(mostLinked) ?? 0} backlinks`, () => ({
    vault: v,
    path: mostLinked,
  }));
  await measure("list_notes", "default limit (200)", () => ({ vault: v }));
  // read_resources shares readResource with resources/read, whose only selector is the config
  // default; the same text comes back either way, so this row is the resources/read figure too.
  await measure("read_resources", "5 notes (= resources/read x5)", () => ({
    uris: spare.slice(0, 5).map((p) => buildResourceUri(v, p)),
  }));

  // ── Part 3 ────────────────────────────────────────────────────────────────────────────────
  // Everything seeded below goes into the COPY or the in-memory databases, never the source.
  const ctxWith = (over: Partial<CallerContext>): CallerContext => ({ ...ctx, ...over });
  const confirmed = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    const need = await registry.dispatch(tool, args, ctx);
    if (need.ok || need.error.code !== "elicit_required")
      throw new Error(`${tool}: expected elicit_required`);
    const hash = String((need.error.details as { args_hash?: string }).args_hash);
    const token = issueElicitToken(db, {
      vaultId: v,
      toolName: tool,
      argsHash: hash,
      caller: "eval",
    });
    const r = await registry.dispatch(tool, args, ctxWith({ elicitToken: token }));
    if (!r.ok) throw new Error(`${tool} failed: ${r.error.code}: ${r.error.message}`);
    return r.data;
  };

  // list_attachments: 40 files in two formats, half of them embedded by a note.
  mkdirSync(join(vaultDir, "assets"), { recursive: true });
  for (let i = 0; i < 40; i++)
    writeFileSync(join(vaultDir, "assets", `figure-${i}.${i % 2 ? "png" : "pdf"}`), `bytes-${i}`);
  writeFileSync(
    join(vaultDir, "attachment-refs.md"),
    `${Array.from({ length: 20 }, (_, i) => `![[figure-${i * 2 + 1}.png]]`).join("\n")}\n`,
  );
  await measure("list_attachments", "40 files, reference counts on", () => ({
    vault: v,
    include_reference_count: true,
  }));

  // list_periodic_notes: 30 daily notes in a 30-day window.
  for (let d = 1; d <= 30; d++)
    writeFileSync(
      join(vaultDir, `2026-09-${String(d).padStart(2, "0")}.md`),
      `# Day ${d}\n\nmemory note ${d}\n`,
    );
  await measure("list_periodic_notes", "30 daily notes", () => ({
    vault: v,
    period: "daily",
    from: "2026-09-01",
    to: "2026-09-30",
  }));

  // list_snapshots: ten point-in-time copies of one note.
  for (let i = 0; i < 10; i++)
    captureSnapshot(
      db,
      { enabled: true, retention: 20 },
      v,
      spare[8] as string,
      `snapshot body ${i}\n`,
      i % 2 ? "patch" : "write",
      () => 1_700_000_000_000 + i,
    );
  await measure("list_snapshots", "10 snapshots", () => ({ vault: v, path: spare[8] }));

  // rewrite_link and prune_hub_links: a real run per arm against identically shaped fixtures
  // (ra* for one arm, rb* for the other, so both arms see the same counts), plus a dry run.
  const hubBody = (target: string) =>
    `# Hub\n${Array.from({ length: 12 }, (_, i) => `- [[${target}]] item ${i}\n- [[dangling-${i}]]\n`).join("")}`;
  for (const arm of ["ra", "rb"]) {
    writeFileSync(join(vaultDir, `${arm}-target.md`), "# Target\n");
    for (let i = 0; i < 10; i++)
      writeFileSync(join(vaultDir, `${arm}-src-${i}.md`), `see [[${arm}-target]] and more\n`);
    writeFileSync(join(vaultDir, `${arm}-hub.md`), hubBody(`${arm}-target`));
  }
  const armKey = (arm: "detailed" | "concise"): string => (arm === "detailed" ? "ra" : "rb");
  await measure("rewrite_link", "dry run, 10 notes", (arm) => ({
    vault: v,
    from_target: `${armKey(arm)}-target`,
    to_target: `${armKey(arm)}-renamed`,
    dry_run: true,
  }));
  {
    const run = async (arm: "detailed" | "concise"): Promise<number> =>
      size(
        await confirmed("rewrite_link", {
          vault: v,
          from_target: `${armKey(arm)}-target`,
          to_target: `${armKey(arm)}-renamed`,
          dry_run: false,
          response_format: arm,
        }),
      );
    rows.push({
      tool: "rewrite_link",
      call: "real run, 10 notes",
      detailed: await run("detailed"),
      concise: await run("concise"),
    });
  }
  await measure("prune_hub_links", "dry run, 12 dangling links", (arm) => ({
    vault: v,
    path: `${armKey(arm)}-hub.md`,
    dry_run: true,
  }));
  {
    const run = async (arm: "detailed" | "concise"): Promise<number> =>
      size(
        await confirmed("prune_hub_links", {
          vault: v,
          path: `${armKey(arm)}-hub.md`,
          dry_run: false,
          response_format: arm,
        }),
      );
    rows.push({
      tool: "prune_hub_links",
      call: "real run, 12 dangling links",
      detailed: await run("detailed"),
      concise: await run("concise"),
    });
  }

  // m7 search tools. The lexical route answers a rare single token without an embedder.
  await measure("search_and_read", "k=5, mode=note", () => ({
    vault: v,
    query: "memory practice",
    k: 5,
  }));
  await measure("search_and_read", "k=5, mode=section", () => ({
    vault: v,
    query: "memory practice",
    k: 5,
    mode: "section",
  }));
  await measure("vault_graph_search", "final_top_k=10", () => ({
    vault: v,
    query: "memory practice",
    final_top_k: 10,
  }));
  // knowledge_search: 40 corpus notes copied into a docs-kind vault and indexed through the same
  // index_vault path (the fake embedder, so the standard route returns hits).
  for (const p of notes.slice(0, 40)) {
    mkdirSync(dirname(join(docsDir, p)), { recursive: true });
    cpSync(join(vaultDir, p), join(docsDir, p));
  }
  // knowledge_get_critical lists the docs notes whose frontmatter carries a severity.
  for (let i = 0; i < 12; i++)
    writeFileSync(
      join(docsDir, `advisory-${i}.md`),
      `---\nseverity: ${i % 3 ? "critical" : "important"}\ncategory: ${i % 2 ? "breaking_change" : "deprecation"}\nsource: vendor-${i % 4}\n---\n# Advisory ${i}\n\nmemory practice advisory body ${i}.\n`,
    );
  await call("index_vault", { vault: "docs" });
  {
    const docsCtx = ctxWith({ vaultId: "docs", grantedScopes: new Set(["read:docs"]) });
    const ks = async (arm: "detailed" | "concise"): Promise<number> => {
      const r = await registry.dispatch(
        "knowledge_search",
        { vault: "docs", query: "memory practice", response_format: arm },
        docsCtx,
      );
      if (!r.ok) throw new Error(`knowledge_search failed: ${r.error.code}: ${r.error.message}`);
      return size(r.data);
    };
    rows.push({
      tool: "knowledge_search",
      call: "40 docs notes indexed, default top_k",
      detailed: await ks("detailed"),
      concise: await ks("concise"),
    });
  }

  // m5 memory, capture, session and bootstrap reads.
  for (let i = 0; i < 20; i++)
    await call("enqueue_capture", {
      vault: v,
      content: `capture ${i}: a thought about memory and practice, long enough to preview`,
      ...(i % 2 ? { title: `Capture ${i}`, tags: ["idea"], source: "web" } : {}),
    });
  await measure("list_capture_queue", "20 pending captures", () => ({ vault: v }));
  const seedEntity = (await call("create_entity", {
    vault: v,
    type: "topic",
    name: "Memory",
    observations: ["first fact", "second fact", "third fact"],
    materialize: false,
  })) as { entity_id: string };
  for (let i = 0; i < 12; i++) {
    const other = (await call("create_entity", {
      vault: v,
      type: "topic",
      name: `Related ${i}`,
      observations: [`fact about related ${i}`, "another fact"],
      materialize: false,
    })) as { entity_id: string };
    await call("link_entities", {
      vault: v,
      source_id: seedEntity.entity_id,
      target_id: other.entity_id,
      relation_type: "relates_to",
    });
  }
  await measure("get_entity", "3 observations, 12 relations", () => ({
    vault: v,
    entity_id: seedEntity.entity_id,
  }));
  await measure("query_entity_graph", "12 neighbours", () => ({
    vault: v,
    seed_entity_id: seedEntity.entity_id,
  }));
  const session = (await call("start_session", { vault: v, caller: "eval" })) as {
    session_id: string;
    trace_path: string;
  };
  const traceAbs = resolveTraceAbs({
    store: "cache",
    tracePath: session.trace_path,
    cacheDir,
    vaultRoot: vaultDir,
  });
  for (let i = 0; i < 40; i++)
    appendTrace(traceAbs, {
      ts: 1_700_000_000_000 + i,
      type: "event",
      tool: i % 2 ? "read_note" : "search_text",
      caller: "eval",
      args_hash: `a1b2c3d4e5f6${i}`,
      duration_ms: 3 + i,
    });
  await measure("get_session_traces", "40 records", () => ({
    vault: v,
    session_id: session.session_id,
  }));
  await measure("session_bootstrap", "mode=deep, 5 notes", () => ({ vault: v, mode: "deep" }));

  // m8 reads: 60 episodes in 6 amendment chains, 8 goals, one persisted gap report.
  for (let i = 0; i < 60; i++)
    edb
      .prepare(
        `INSERT INTO agent_episodes (id, ts, vault_id, session_id, caller, channel, episode_type,
           tool, status, error_code, duration_ms, result_size, eligibility, trust, blocked, valid_from,
           summary, prev_id)
         VALUES (?, ?, 'v', 'sess-1', 'eval', 'dispatch', 'tool_call', ?, ?, ?, 12, 345,
           'eligible', 0.6, 0, ?, ?, ?)`,
      )
      .run(
        `ep-${i}`,
        1_700_000_000_000 + i * 1000,
        i % 3 ? "read_note" : "search_text",
        i % 7 ? "ok" : "error",
        i % 7 ? null : "note_not_found",
        1_700_000_000_000 + i * 1000,
        `worked on memory and practice step ${i}`,
        i % 10 === 0 ? null : `ep-${i - 1}`,
      );
  for (let i = 0; i < 8; i++)
    await call("set_goal", { vault: v, text: `goal ${i}: improve memory practice` });
  edb
    .prepare(
      `INSERT INTO gap_reports (vault_id, computed_at, threshold, min_results, total, gaps, gap_rate, items)
       VALUES ('v', ?, 0.5, 1, 30, 10, 0.33, ?)`,
    )
    .run(
      1_700_000_000_000,
      JSON.stringify(
        Array.from({ length: 30 }, (_, i) => ({
          id: `q${i}`,
          query: `question number ${i} about memory`,
          top_score: (i % 10) / 10,
          results: i % 4,
          gap: i % 3 === 0,
          nearest: [{ path: notes[i] as string, score: 0.5 }],
        })),
      ),
    );
  await measure("list_goals", "8 goals", () => ({ vault: v }));
  await measure("work_episodes", "60 episodes", () => ({ k: 60 }));
  await measure("work_episode_chain", "chain of 9", () => ({ id: "ep-9" }));
  await measure("work_search", "query=memory", () => ({ query: "memory" }));
  await measure("gap_report", "30 queries", () => ({ vault: v }));

  // ── Part 4a ───────────────────────────────────────────────────────────────────────────────
  // Knowledge reads, link/tag/health analysis, bundles and the canvas reader. Seeds go into the
  // COPY and the in-memory databases only.
  {
    // explain_answer: 8 logged retrievals for one session, real chunk ids from the indexed vault,
    // half of them cited, one whose chunk no longer resolves.
    const chunks = db
      .prepare("SELECT id FROM chunks WHERE vault_id = ? ORDER BY path, chunk_index LIMIT 8")
      .all(v) as Array<{ id: string }>;
    if (chunks.length < 8) throw new Error("part 4a: fewer than 8 indexed chunks");
    const log = edb.prepare(
      `INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, surface_type,
         query_text, rank_in_results, cited_in_response, citation_score, citation_state, caller)
       VALUES (?, ?, ?, 'eval-s1', 'vault_graph_search', 'memory practice', ?, ?, ?, ?, 'eval')`,
    );
    chunks.forEach((c, i) => {
      const cited = i % 2 === 0;
      log.run(
        `er-${i}`,
        c.id,
        1_700_000_000_000 + i,
        i + 1,
        cited ? 1 : null,
        cited ? 0.8 : null,
        cited ? "confirmed" : null,
      );
    });
    log.run("er-gone", "chunk-that-was-rechunked", 1_700_000_000_100, 9, null, null, null);
  }
  // bundle_folder: 15 notes in their own folder of the copy.
  for (const p of spare.slice(10, 25)) {
    mkdirSync(join(vaultDir, "bundle-src"), { recursive: true });
    cpSync(join(vaultDir, p), join(vaultDir, "bundle-src", `${p.split("/").pop()}`));
  }
  // read_canvas: 20 text nodes, 19 edges, written into the copy.
  writeFileSync(
    join(vaultDir, "board.canvas"),
    JSON.stringify({
      nodes: Array.from({ length: 20 }, (_, i) => ({
        id: `n${i}`,
        type: "text",
        text: `Card ${i}: memory practice`,
        x: (i % 5) * 300,
        y: Math.floor(i / 5) * 200,
        width: 260,
        height: 120,
      })),
      edges: Array.from({ length: 19 }, (_, i) => ({
        id: `e${i}`,
        fromNode: `n${i}`,
        toNode: `n${i + 1}`,
      })),
    }),
  );
  await measure("vault_context", "query=memory", () => ({ vault: v, query: "memory" }));
  await measure("explain_answer", "8 retrievals, 1 unresolved", () => ({
    vault: v,
    session_id: "eval-s1",
  }));
  await measure("diagnose_retrieval", "query=memory practice, one note", () => ({
    vault: v,
    query: "memory practice",
    path: spare[0],
  }));
  await measure("knowledge_get_critical", "12 advisories", () => ({ vault: "docs" }));
  await measure("audit_provenance", "whole vault", () => ({ vault: v }));
  await measure("vault_health_score", "whole vault", () => ({ vault: v }));
  await measure(
    "suggest_links",
    `most-linked note (${inbound.get(mostLinked) ?? 0} inbound)`,
    () => ({
      vault: v,
      path: mostLinked,
    }),
  );
  await measure("suggest_tags", "median note", () => ({ vault: v, path: median }));
  await measure("bundle_files", "10 notes", () => ({ vault: v, paths: spare.slice(0, 10) }));
  await measure("bundle_folder", "15-note folder", () => ({ vault: v, root: "bundle-src" }));
  await measure("read_canvas", "20 nodes, 19 edges", () => ({ vault: v, path: "board.canvas" }));

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
}

await main();
// The registry and the in-memory databases keep handles open, so bun would not exit on its own.
process.exit(0);
