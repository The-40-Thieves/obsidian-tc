#!/usr/bin/env node
// check-mcp-name (THE-940) — the MCP Registry proves npm-package ownership by matching
// packages/server/package.json's `mcpName` field, EXACT case, against server.json's `name`
// (https://modelcontextprotocol.io/registry — "Validate ownership"). A drift here is invisible
// until a publish attempt 422s against the live registry, at which point the tag is already
// pushed and the rest of publish.yml has already run. This gate catches it on every PR instead.
//
// Also asserts server.json's `description` is at most 100 characters — the registry's own cap
// (server.schema.json's `description` maxLength) — for the same reason: a description edited
// past the cap here fails at publish time, not PR time.
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(".");
const DESCRIPTION_MAX = 100;

const readJson = (p) => {
  const target = resolve(ROOT, p);
  if (relative(ROOT, target).startsWith("..")) {
    throw new Error(`refusing to read outside repo root: ${p}`);
  }
  return JSON.parse(readFileSync(target, "utf8"));
};

/**
 * Pure check, injectable so it is testable without a filesystem. Returns a list of problem
 * strings; an empty list means the gate passes.
 */
export function mcpNameProblems({
  serverName,
  pkgMcpName,
  description,
  descriptionMax = DESCRIPTION_MAX,
}) {
  const problems = [];
  if (!pkgMcpName) {
    problems.push(
      "packages/server/package.json is missing an `mcpName` field — the MCP Registry needs it to " +
        "validate npm-package ownership against server.json's `name`.",
    );
  } else if (pkgMcpName !== serverName) {
    problems.push(
      `packages/server/package.json's mcpName ("${pkgMcpName}") does not exactly match ` +
        `server.json's name ("${serverName}") — the registry's ownership check is a case-sensitive ` +
        "exact match and will 422 at publish time on any drift.",
    );
  }
  if (typeof description !== "string" || description.length === 0) {
    problems.push("server.json is missing a `description`.");
  } else if (description.length > descriptionMax) {
    problems.push(
      `server.json's description is ${description.length} characters, over the registry's ` +
        `${descriptionMax}-character cap.`,
    );
  }
  return problems;
}

function main() {
  const pkg = readJson("packages/server/package.json");
  const server = readJson("server.json");

  const problems = mcpNameProblems({
    serverName: server.name,
    pkgMcpName: pkg.mcpName,
    description: server.description,
  });

  if (problems.length > 0) {
    console.error("check-mcp-name: FAIL");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(
    `check-mcp-name: OK — mcpName "${pkg.mcpName}" matches server.json's name, description is ` +
      `${server.description.length}/${DESCRIPTION_MAX} characters.`,
  );
}

// Importing this module (as its test file does) must have no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
