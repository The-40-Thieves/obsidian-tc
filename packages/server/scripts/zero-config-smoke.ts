// THE-941: proves the zero-config front door (`obsidian-tc <vault>`, no config file) actually
// works with Ollama absent, over the real MCP stdio transport against the real built CLI. Spawns
// via literal `node`, not `bun` — that is exactly what `npx obsidian-tc <vault>` resolves to and
// runs (package.json's `bin` field points at this same dist/cli.js).
//
// Generates a small fixture vault (five notes, wikilinks, one frontmatter field) and asserts, over
// stdio: initialize succeeds, tools/list returns the 3-tool triad, search_text finds a seeded
// phrase, get_index_status reports the expected reconcile state (embeddings degraded, never an
// error — nothing here stubs the provider), and the process exits on SIGTERM.
//
// --require-ollama-config points the CLI at a config file (not the vault dir) that names the
// `ollama` provider explicitly and expects it to reach "ok", not "degraded" — used once, manually,
// to prove this smoke goes red the moment it stops exercising the true no-config path (see the
// THE-941 task report). It is not part of the regular CI job.
//
//   bun scripts/zero-config-smoke.ts --cli <path/to/dist/cli.js>
//     [--seed-phrase <word>] [--omit-seed-phrase] [--require-ollama-config]

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
const expectReconcile = requireOllamaConfig ? "ok" : "degraded";

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

  const statusRes = await client.callTool({
    name: "call_capability",
    arguments: { name: "get_index_status", args: {} },
  });
  if (statusRes.isError) fail(`get_index_status errored: ${JSON.stringify(statusRes.content)}`);
  const statusContent = statusRes.content as Array<{ type: string; text: string }>;
  const status = JSON.parse(statusContent[0]?.text ?? "null") as { reconcile?: string };
  if (status.reconcile !== expectReconcile) {
    fail(
      `get_index_status.reconcile was "${status.reconcile}", expected "${expectReconcile}" — ` +
        "embeddings should degrade the index, never error, with Ollama absent",
    );
  }
  process.stderr.write(`ok: get_index_status.reconcile is "${expectReconcile}", not an error\n`);

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
