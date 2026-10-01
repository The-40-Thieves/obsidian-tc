// Proves the SHARED rate-limit backends work in the real built CLI, over real MCP stdio, across two
// real server processes: `bun scripts/ratelimit-shared-smoke.ts --cli dist/cli.js --backend sqlite|redis`.
// With `--image <tag>` (redis only) the two servers are containers of that image on the host
// network, which proves the image ships a resolvable @redis/client.
//
// Two servers share one cacheDir (sqlite) or one Redis (redis) and a read tier of burst 3, refill
// 1/min. Six governed calls, three through each server, must yield EXACTLY three successes and three
// `throttled` refusals: with process-local buckets each server would grant its own three (six ok).
// The redis backend reads its URL from OBSIDIAN_TC_REDIS_URL, so this also proves the built bundle
// loads the optional client lazily from node_modules.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
function fail(message: string): never {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

const image = arg("--image");
const cli = image
  ? ""
  : (arg("--cli") ?? fail("--cli <path/to/dist/cli.js> or --image <tag> is required"));
const backend = arg("--backend");
if (backend !== "sqlite" && backend !== "redis") fail("--backend must be sqlite or redis");
const redisUrl = process.env.OBSIDIAN_TC_REDIS_URL;
if (backend === "redis" && !redisUrl) fail("--backend redis needs OBSIDIAN_TC_REDIS_URL");

const root = mkdtempSync(join(tmpdir(), "obtc-rl-smoke-"));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const vault = join(root, "vault");
const cacheDir = join(root, "cache");
const keyPrefix = `smoke:${Date.now()}:`;

mkdirSync(vault, { recursive: true });
writeFileSync(join(vault, "welcome.md"), "# Welcome\n\nquartzlighthouseprotocol\n");
const configPath = join(root, "config.json");
writeFileSync(
  configPath,
  JSON.stringify({
    vaults: [{ id: "main", path: vault }],
    cacheDir,
    toolFacade: { mode: "flat" },
    throttle: {
      backend,
      tiers: { read: { perMinute: 1, burst: 3 } },
      redis: { keyPrefix },
    },
  }),
);

async function connect(name: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: image ? "docker" : "node",
    args: image
      ? [
          "run",
          "-i",
          "--rm",
          "--network",
          "host",
          "--user",
          String(process.getuid?.() ?? 1000),
          "-e",
          "OBSIDIAN_TC_REDIS_URL",
          "-v",
          `${root}:${root}`,
          image,
          configPath,
        ]
      : [cli, configPath],
    stderr: "inherit",
    env: { ...(process.env as Record<string, string>) },
  });
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const a = await connect("smoke-a");
const b = await connect("smoke-b");
let ok = 0;
let throttled = 0;
for (let i = 0; i < 3; i++) {
  for (const client of [a, b]) {
    const res = await client.callTool({
      name: "search_text",
      arguments: { vault: "main", query: "quartzlighthouseprotocol" },
    });
    if (!res.isError) ok++;
    else if (JSON.stringify(res.content).includes("throttled")) throttled++;
    else fail(`unexpected error: ${JSON.stringify(res.content)}`);
  }
}
await a.close();
await b.close();
if (ok !== 3 || throttled !== 3) {
  fail(
    `${backend}: expected 3 ok + 3 throttled across two servers, got ${ok} ok + ${throttled} throttled`,
  );
}
process.stderr.write(
  `ok: ${backend} backend shared across two built CLI processes (3 ok, 3 throttled)\n`,
);
