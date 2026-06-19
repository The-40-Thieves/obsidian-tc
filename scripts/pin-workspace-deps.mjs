// Pin workspace:* dependency specifiers to concrete versions in the publishable
// package.json files. `npm publish` does NOT rewrite the workspace: protocol (unlike
// `bun publish`), so without this the published obsidian-tc would ship
// "@the-40-thieves/obsidian-tc-shared": "workspace:*" and fail to install. We keep
// npm publish (for --provenance, which bun publish lacks) and run this first.
//
// Mirrors bun's resolution: workspace:* -> <version>, workspace:^ -> ^<version>,
// workspace:~ -> ~<version>, workspace:<range> -> <range>. Run from the repo root.
// Pass --check to preview without writing.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const check = process.argv.includes("--check");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const rootPkg = readJson(join(root, "package.json"));
const dirs = [];
for (const pattern of rootPkg.workspaces ?? []) {
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2);
    const baseAbs = join(root, base);
    if (!existsSync(baseAbs)) {
      continue;
    }
    for (const entry of readdirSync(baseAbs, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        dirs.push(`${base}/${entry.name}`);
      }
    }
  } else {
    dirs.push(pattern);
  }
}

const versions = {};
for (const dir of dirs) {
  const path = join(root, dir, "package.json");
  if (!existsSync(path)) {
    continue;
  }
  const pkg = readJson(path);
  if (pkg.name && pkg.version) {
    versions[pkg.name] = pkg.version;
  }
}

const WORKSPACE_DEP = /"((?:@[^"/]+\/)?[^"]+)":\s*"workspace:([^"]*)"/g;
let pinned = 0;

for (const dir of dirs) {
  const path = join(root, dir, "package.json");
  if (!existsSync(path)) {
    continue;
  }
  const before = readFileSync(path, "utf8");
  const after = before.replace(WORKSPACE_DEP, (match, name, spec) => {
    const version = versions[name];
    if (!version) {
      return match;
    }
    let range;
    if (spec === "*" || spec === "") {
      range = version;
    } else if (spec === "^" || spec === "~") {
      range = spec + version;
    } else {
      range = spec;
    }
    pinned += 1;
    return `"${name}": "${range}"`;
  });
  if (after !== before) {
    if (check) {
      console.log(`[pin] ${dir}/package.json: would pin workspace deps`);
    } else {
      writeFileSync(path, after);
      console.log(`[pin] ${dir}/package.json: pinned workspace deps`);
    }
  }
}

console.log(`[pin] workspace specifiers ${check ? "found" : "pinned"}: ${pinned}`);
