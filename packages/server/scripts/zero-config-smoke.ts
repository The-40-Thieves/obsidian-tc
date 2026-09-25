// THE-941: proves the zero-config front door (`obsidian-tc <vault>`, no config file) actually
// works over the real MCP stdio transport against the real built CLI. Spawns via literal `node`,
// not `bun` — that is exactly what `npx obsidian-tc <vault>` resolves to and runs (package.json's
// `bin` field points at this same dist/cli.js).
//
// Generates a small fixture vault (five notes, wikilinks, one frontmatter field) and asserts, over
// stdio: initialize succeeds, tools/list returns the 3-tool triad, search_text finds a seeded
// phrase, get_index_status reports the expected reconcile state (never an ERROR — nothing here
// stubs the provider), and the process exits on SIGTERM.
//
// DEFAULT MODE (no flag): asserts `assertPortClosed(11434)` and expects reconcile "degraded".
// THE-1122 changed what this is actually testing: `embeddings.provider` now defaults to "local",
// not "ollama" — the 127.0.0.1:11434 check is no longer "is the active provider unreachable", it
// is a vestigial guard against a stray Ollama being mistaken for anything relevant (harmless to
// keep, asserts a true fact, but not the load-bearing check it used to be). This job's own CI
// wiring (ci-server.yml's `zero-config-smoke` job) builds packages/server but deliberately does
// NOT build packages/embedder-local, so "local" resolution fails there and reconcile genuinely is
// "degraded" — now for "the optional local embedder isn't built/available in this environment"
// (the same degrade path an npm/Docker install hits today per embeddings.md's Known Gaps), not
// "Ollama is absent". Still a real, worth-having assertion: embeddings unavailable must degrade
// the index, never error boot — see reference_obsidian_tc_has_no_embeddings_off_switch.
//
// --expect-local-embeddings (THE-1122 item 8) is the OTHER half: a clean install where
// packages/embedder-local IS built and its pinned weights ARE available expects reconcile to
// settle at "ok" (real local embeddings actually working, not merely "not crashing"), and
// additionally exercises search_semantic — the tool search_text alone cannot prove works, since
// search_text never touches the vector store. Polls get_index_status rather than asserting
// immediately, because a REAL first embed here is a real model load + CPU ONNX inference (small on
// this five-note fixture, but not instantaneous the way Ollama's immediate ECONNREFUSED is).
//
// --require-ollama-config points the CLI at a config file (not the vault dir) that names the
// `ollama` provider explicitly and expects it to reach "ok", not "degraded" — used once, manually,
// to prove this smoke goes red the moment it stops exercising the true no-config path (see the
// THE-941 task report). It is not part of the regular CI job.
//
//   bun scripts/zero-config-smoke.ts --cli <path/to/dist/cli.js>
//     [--seed-phrase <word>] [--omit-seed-phrase] [--require-ollama-config]
//     [--expect-local-embeddings] [--reconcile-timeout-ms <ms>]

import { mkdtempSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const cliPath = arg("--cli");
if (!cliPath) {
  process.stderr.write("zero-config-smoke: --cli <path/to/dist/cli.js> is required\n");
  process.exit(2);
}
const seedPhrase = arg("--seed-phrase") ?? "quartzlighthouseprotocol";
const omitSeedPhrase = process.argv.includes("--omit-seed-phrase");
const requireOllamaConfig = process.argv.includes("--require-ollama-config");
const expectLocalEmbeddings = process.argv.includes("--expect-local-embeddings");
const reconcileTimeoutMs = Number(arg("--reconcile-timeout-ms") ?? "120000");
if (requireOllamaConfig && expectLocalEmbeddings) {
  process.stderr.write(
    "zero-config-smoke: --require-ollama-config and --expect-local-embeddings are mutually exclusive\n",
  );
  process.exit(2);
}
const expectReconcile = requireOllamaConfig || expectLocalEmbeddings ? "ok" : "degraded";

function fail(message: string): never {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

// The default embeddings.baseUrl (indexing-embeddings.schema.ts + embeddings/providers.ts) is
// this loopback port. Confirm nothing answers it BEFORE booting — the point of this smoke is that
// the no-config path never reaches a live Ollama, not that one merely happens to be absent.
async function assertPortClosed(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port, timeout: 1000 });
    sock.once("connect", () => {
      sock.destroy();
      reject(new Error(`127.0.0.1:${port} is OPEN — Ollama's default port must be closed`));
    });
    sock.once("timeout", () => {
      sock.destroy();
      resolve();
    });
    sock.once("error", () => resolve());
  });
}

function makeFixtureVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "obtc-zero-config-smoke-"));
  const phrase = omitSeedPhrase ? "unrelated-marker-text" : seedPhrase;
  const notes: Record<string, string> = {
    "welcome.md": `---\ntags: [reference, smoke]\n---\n# Welcome\n\nThe load-bearing phrase is ${phrase}.\n\nSee [[architecture]] and [[glossary]].\n`,
    "architecture.md": `# Architecture\n\nLinks: [[welcome]], [[glossary]], [[changelog]].\n`,
    "glossary.md": `# Glossary\n\nReferenced from [[welcome]] and [[architecture]].\n`,
    "changelog.md": `# Changelog\n\n- Initial cut. See [[welcome]].\n`,
    "appendix.md": `# Appendix\n\nCross-links: [[architecture]], [[glossary]].\n`,
  };
  for (const [name, body] of Object.entries(notes)) writeFileSync(join(dir, name), body);
  return dir;
}

function makeRequiresOllamaConfig(vaultDir: string): string {
  const dir = mkdtempSync(join(tmpdir(), "obtc-zero-config-smoke-cfg-"));
  const path = join(dir, "requires-ollama.config.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        vaults: [{ id: "main", path: vaultDir }],
        cacheDir: join(dir, "cache"),
        embeddings: { provider: "ollama", baseUrl: "http://127.0.0.1:11434" },
      },
      null,
      2,
    ),
  );
  return path;
}

async function main(): Promise<void> {
  await assertPortClosed(11434);
  process.stderr.write("ok: 127.0.0.1:11434 (Ollama default) is closed on this runner\n");

  const vaultDir = makeFixtureVault();
  const target = requireOllamaConfig ? makeRequiresOllamaConfig(vaultDir) : vaultDir;

  const transport = new StdioClientTransport({
    command: "node",
    args: [cliPath, target],
    stderr: "inherit",
  });
  const client = new Client({ name: "zero-config-smoke", version: "0.0.0" });

  let serverClosed = false;
  client.onclose = () => {
    serverClosed = true;
  };

  await client.connect(transport);
  process.stderr.write("ok: initialize succeeded over stdio\n");

  const listed = await client.listTools();
  const names = new Set(listed.tools.map((t) => t.name));
  const triad = ["find_capability", "describe_capability", "call_capability"];
  if (names.size !== 3 || !triad.every((n) => names.has(n))) {
    fail(`tools/list did not return the triad — got ${[...names].join(", ")}`);
  }
  process.stderr.write("ok: tools/list returned the triad\n");

  const searchRes = await client.callTool({
    name: "call_capability",
    arguments: { name: "search_text", args: { vault: "main", query: seedPhrase } },
  });
  if (searchRes.isError) fail(`search_text errored: ${JSON.stringify(searchRes.content)}`);
  const searchText = JSON.stringify(searchRes.content);
  if (!searchText.includes("welcome")) {
    fail(`search_text did not find the seeded phrase "${seedPhrase}" — got: ${searchText}`);
  }
  process.stderr.write(`ok: search_text found the seeded phrase (${seedPhrase})\n`);

  async function getReconcile(): Promise<string | undefined> {
    const statusRes = await client.callTool({
      name: "call_capability",
      arguments: { name: "get_index_status", args: {} },
    });
    if (statusRes.isError) fail(`get_index_status errored: ${JSON.stringify(statusRes.content)}`);
    const statusContent = statusRes.content as Array<{ type: string; text: string }>;
    const status = JSON.parse(statusContent[0]?.text ?? "null") as { reconcile?: string };
    return status.reconcile;
  }

  // THE-1122 item 8: --expect-local-embeddings drives a REAL model load + CPU ONNX inference on
  // the first embed, which is not instantaneous the way Ollama's immediate ECONNREFUSED-driven
  // "degraded" is — poll rather than assert on the first read, so this does not flake on a
  // slightly slower runner. Every other mode's reconcile already settles by the time `initialize`
  // returns (no real provider work happens), so they keep the single immediate read.
  let finalReconcile: string | undefined;
  if (expectLocalEmbeddings) {
    const deadline = Date.now() + reconcileTimeoutMs;
    for (;;) {
      finalReconcile = await getReconcile();
      if (finalReconcile !== "pending") break;
      if (Date.now() >= deadline) {
        fail(
          `get_index_status.reconcile stayed "pending" for ${reconcileTimeoutMs}ms — the local ` +
            "embedder never finished its first embed (model download/load too slow, or wedged)",
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  } else {
    finalReconcile = await getReconcile();
  }
  if (finalReconcile !== expectReconcile) {
    fail(
      `get_index_status.reconcile was "${finalReconcile}", expected "${expectReconcile}" — ` +
        "embeddings should degrade the index, never error, when unavailable",
    );
  }
  process.stderr.write(`ok: get_index_status.reconcile is "${expectReconcile}", not an error\n`);

  // THE-1122 item 8: search_text alone never proves the vector store actually works — it is FTS,
  // not dense retrieval. This is the end-to-end proof that a clean install with the DEFAULT
  // ("local") provider produces real, queryable vectors, not just a non-error boot.
  if (expectLocalEmbeddings) {
    const semanticRes = await client.callTool({
      name: "call_capability",
      arguments: { name: "search_semantic", args: { vault: "main", query: seedPhrase, k: 5 } },
    });
    if (semanticRes.isError) {
      fail(`search_semantic errored: ${JSON.stringify(semanticRes.content)}`);
    }
    const semanticText = JSON.stringify(semanticRes.content);
    if (!semanticText.includes("welcome")) {
      fail(
        `search_semantic did not find the seeded note for "${seedPhrase}" — got: ${semanticText}`,
      );
    }
    process.stderr.write(`ok: search_semantic found the seeded note (${seedPhrase})\n`);
  }

  const pid = transport.pid;
  if (pid === null) fail("no pid to send SIGTERM to");
  process.kill(pid, "SIGTERM");
  const closed = await Promise.race([
    new Promise<boolean>((resolve) => {
      const check = () => (serverClosed ? resolve(true) : setTimeout(check, 100));
      check();
    }),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
  ]);
  if (!closed) fail("process did not exit within 10s of SIGTERM");
  process.stderr.write("ok: process exited cleanly on SIGTERM\n");

  await client.close();
  process.stderr.write("PASS: zero-config smoke\n");
}

main().catch((err) => fail((err as Error).stack ?? String(err)));
