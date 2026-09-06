#!/usr/bin/env bun
// Emit the Smithery server card (THE-966) at dist/smithery-server-card.json (repo root, matching
// bundle-mcpb.ts's outFile convention — both land in the same directory so publish.yml's
// build-mcpb job can upload them as one artifact for publish-smithery to consume).
//
// WHY THIS EXISTS. `smithery mcp publish <bundle>.mcpb` only forwards the MCPB manifest's `tools`
// array, and that array cannot carry `inputSchema` (upstream smithery-cli#787, open since July
// 2026) — our manifest declares no tools, so the CLI path always produced an empty server card.
// The registry API accepts a `serverCard` in its deploy payload with full MCP-shaped tools
// (`inputSchema` included), so scripts/publish-smithery.mjs now builds and sends one directly.
// This script generates that card from the REAL, already-registered definitions rather than
// hand-copying schemas into a second, driftable source of truth:
//   - tools: the three triad facade tools (find_capability, describe_capability,
//     call_capability), via facade.ts's own `triadTools()` builder — the same function
//     mcp/server.ts calls for tools/list, so the card can never advertise a schema the live
//     server does not.
//   - prompts: the built-in prompt catalog, via prompts.ts's own `listPrompts()`.
//   - resources: the `obsidian-tc://catalog` resource entry, via resources.ts's own
//     `catalogResourceEntry()`.
// `triadTools(hasResources)`/`listPrompts()`/`catalogResourceEntry()` are pure and take no
// registry — no VaultRegistry, no ToolRegistry, no config — so this script needs none of the
// server's runtime wiring, only its TS source (mirrors the docgen scripts' own import shape:
// packages/server/scripts/docgen/*.ts import directly from ../../src/**).
//
// `buildServerCard` is exported and kept pure (no fs access) so
// packages/server/test/smithery-server-card.test.ts can assert on its output shape the same way
// test/docgen-extractors.test.ts exercises the docgen scripts — everything below it is this file's
// only side-effecting code (reading package.json/server.json, writing OUT), run only when this
// module is executed directly (`bun packages/server/scripts/gen-smithery-server-card.ts`), not
// when a test imports it.
//
// usage:
//   bun packages/server/scripts/gen-smithery-server-card.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { triadTools } from "../src/mcp/facade";
import { listPrompts } from "../src/mcp/prompts";
import { catalogResourceEntry } from "../src/mcp/resources";

export interface ServerCardInputs {
  /** packages/server/package.json's own `name` + `version`. */
  serverPkg: { name: string; version: string };
  /** The repo-root MCP registry manifest (server.json) — `description` + `title`. */
  mcpServerJson: { description: string; title?: string };
}

/**
 * Builds the Smithery server card from the server's real tool/prompt/resource definitions. Pure —
 * no fs access — so it is testable with fixture inputs and never drifts from what the live server
 * actually advertises (see the module header).
 */
export function buildServerCard({ serverPkg, mcpServerJson }: ServerCardInputs) {
  // hasResources=true: the live deployment always wires a VaultRegistry (see mcp/server.ts's own
  // `triadTools(Boolean(opts.vaultRegistry))` call) — a Smithery-hosted install is never the
  // resource-less fixture configuration the `false` branch exists for (test fixtures with no vault
  // configured yet). Matching the live default keeps the card's tool descriptions identical to
  // what a real caller sees, including the catalog-resource pointer in find_capability's
  // description.
  const tools = triadTools(true).map((t) => ({
    name: t.name,
    ...(t.title ? { title: t.title } : {}),
    ...(t.description ? { description: t.description } : {}),
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
  }));

  const { prompts } = listPrompts();
  const resources = [catalogResourceEntry()];

  return {
    serverInfo: {
      name: serverPkg.name,
      version: serverPkg.version,
      description: mcpServerJson.description,
      title: mcpServerJson.title,
      websiteUrl: "https://github.com/The-40-Thieves/obsidian-tc",
    },
    tools,
    prompts,
    resources,
  };
}

const SERVER_PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(SERVER_PKG_DIR, "..", "..");
const OUT = join(REPO_ROOT, "dist", "smithery-server-card.json");

function main() {
  const serverPkg = JSON.parse(readFileSync(join(SERVER_PKG_DIR, "package.json"), "utf8"));
  const mcpServerJson = JSON.parse(readFileSync(join(REPO_ROOT, "server.json"), "utf8"));
  const serverCard = buildServerCard({ serverPkg, mcpServerJson });

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(serverCard, null, 2)}\n`);
  console.log(
    `\n✓ wrote ${OUT} (${serverCard.tools.length} tools, ${serverCard.prompts.length} prompts, ${serverCard.resources.length} resources)`,
  );
}

// Importing this module (as its test file does) must have no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
