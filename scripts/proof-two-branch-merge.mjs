#!/usr/bin/env node
// Two-branch merge proof: the claim behind "stop generated-file conflicts" is that two PRs which
// each add a tool, a config key, a migration and a release note merge in EITHER order with zero
// manual resolution, and that every generated-artifact gate is still green on the merged tree.
// This script builds exactly that situation in a throwaway worktree of the committed HEAD and
// checks it, so the claim can be re-run rather than remembered:
//
//   node scripts/proof-two-branch-merge.mjs [--keep]
//
// Each branch is cut from the same base and changes, with real source and regenerated artifacts:
//   tool       a new read-only tool file + its registration line + its name in registered-tools.txt
//   config     a new Zod key + regenerated docs/obsidian-tc.config.schema.json
//   migration  a new .sql + its manifest entry + regenerated migrations-embedded.ts
//   fragment   changes/<slug>.md
// Branch a touches the m1 registrar, the snapshots config section and the CACHE migration chain;
// branch b touches the m2 registrar, the writes config section and the EXPERIENTIAL chain, so the
// only file both edit at overlapping lines is migrations-embedded.ts (plus the sorted names list),
// which is what the `regen` merge driver and git's own 3-way merge must carry.
//
// Exit 0 only if: both merge orders succeed with no conflict and leave no markers, the two results
// are the same tree, and every gate below passes on each.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEEP = process.argv.includes("--keep");
const REPO = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const BASE = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();

const WT = join(mkdtempSync(join(tmpdir(), "two-branch-proof-")), "wt");
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "proof",
  GIT_AUTHOR_EMAIL: "proof@example.com",
  GIT_COMMITTER_NAME: "proof",
  GIT_COMMITTER_EMAIL: "proof@example.com",
  // The merge driver's definition normally comes from `bun install`'s prepare script writing the
  // shared .git/config. Supplying it per-process keeps this proof from touching that config while
  // still using the exact command scripts/setup-git-merge-driver.mjs registers.
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "merge.regen.driver",
  GIT_CONFIG_VALUE_0: 'node "scripts/merge-drivers/regen.mjs" %O %A %B %P',
  GIT_CONFIG_KEY_1: "commit.gpgsign",
  GIT_CONFIG_VALUE_1: "false",
};

const git = (...args) =>
  execFileSync("git", args, { cwd: WT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const rd = (rel) => readFileSync(join(WT, rel), "utf8");
const wr = (rel, text) => writeFileSync(join(WT, rel), text);

function insertAfter(rel, anchor, addition) {
  const text = rd(rel);
  if (text.split(anchor).length !== 2) {
    throw new Error(`${rel}: anchor must occur exactly once: ${JSON.stringify(anchor)}`);
  }
  wr(
    rel,
    text.replace(anchor, () => anchor + addition),
  );
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: WT, env, encoding: "utf8", ...opts });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function setup() {
  execFileSync("git", ["worktree", "add", "--detach", WT, BASE], { cwd: REPO, env });
  // node_modules is not checked in; reuse the main checkout's install (read-only use).
  const links = [
    "node_modules",
    ...readdirSync(join(REPO, "packages")).map((p) => `packages/${p}/node_modules`),
  ];
  for (const l of links) {
    if (existsSync(join(REPO, l))) symlinkSync(join(REPO, l), join(WT, l));
  }
}

function toolFile(name, fn, domain) {
  return `import { z } from "zod";
import { defineTool } from "../m1/define";

const Out = z.object({ ok: z.boolean() });

export const ${fn} = () =>
  defineTool({
    name: "${name}",
    domain: "${domain}",
    description: "Proof fixture tool (${name}); read-only, returns ok.",
    inputSchema: z.object({}).strict(),
    outputSchema: Out,
    requiredScopes: ["read:notes"],
    handler: () => ({ ok: true }),
  });
`;
}

function makeBranch(name, who) {
  git("checkout", "-q", "-b", name, BASE);
  const alpha = who === "alpha";
  // tool
  // Names sort far apart in registered-tools.txt, so the two inserts do not share a diff hunk.
  const tool = alpha ? "alpha_proof_tool" : "zeta_proof_tool";
  const fn = alpha ? "createProofAlphaTool" : "createProofBetaTool";
  const dir = alpha ? "m1" : "m2";
  wr(
    `packages/server/src/tools/${dir}/proof-${who}-tool.ts`,
    toolFile(tool, fn, alpha ? "links" : "search"),
  );
  insertAfter(
    `packages/server/src/tools/${dir}/index.ts`,
    alpha
      ? "  for (const tool of buildSnapshotTools(deps)) registry.register(tool);\n"
      : "  for (const tool of buildSearchTools(deps)) registry.register(tool);\n",
    `  registry.register(${fn}());\n`,
  );
  const idx = `packages/server/src/tools/${dir}/index.ts`;
  wr(idx, `import { ${fn} } from "./proof-${who}-tool";\n${rd(idx)}`);
  // name list, kept sorted
  const names = rd("packages/server/test/registered-tools.txt").split("\n").filter(Boolean);
  names.push(tool);
  names.sort();
  wr("packages/server/test/registered-tools.txt", `${names.join("\n")}\n`);
  // config key
  const key = alpha ? "proofAlpha" : "proofBeta";
  insertAfter(
    "packages/shared/src/config/" + (alpha ? "observability" : "runtime") + ".schema.ts",
    alpha
      ? '      .describe("Maximum snapshot versions kept per note. Older versions are pruned."),\n'
      : '        "Require a prev_hash (compare-and-swap) on overwriting writes and on appends to an existing note, failing closed with invalid_input when absent so a stale hash cannot silently clobber.",\n      ),\n',
    `    ${key}: z.boolean().default(false).describe("Proof fixture key ${key}."),\n`,
  );
  // migration
  const sql = alpha ? "29990101_001_proof_alpha.sql" : "29990101_002_proof_beta.sql";
  wr(
    `packages/server/src/migrations/${sql}`,
    `-- proof fixture ${who}\nCREATE TABLE IF NOT EXISTS proof_${who}(id INTEGER PRIMARY KEY);\n`,
  );
  const manifest = "packages/server/src/db/migration-manifest.ts";
  const text = rd(manifest);
  const arr = alpha ? "CACHE_MIGRATION_FILES" : "EXPERIENTIAL_MIGRATION_FILES";
  const start = text.indexOf(`export const ${arr} = [`);
  const close = text.indexOf("\n] as const;", start);
  wr(manifest, `${text.slice(0, close)}\n  "${sql}",${text.slice(close)}`);
  // fragment
  wr(
    `changes/proof-${who}.md`,
    `---\ntype: Added\n---\n- **Proof fixture ${who}.** Adds ${tool}, ${key} and a ${who} migration.\n`,
  );
  // regenerate every derived artifact, exactly as a contributor would
  for (const [cmd, args] of [
    ["bun", ["scripts/gen-config-schema.ts"]],
    ["node", ["scripts/gen-embedded-migrations.mjs"]],
  ]) {
    const r = sh(cmd, args);
    if (!r.ok) throw new Error(`${cmd} ${args.join(" ")} failed on ${name}:\n${r.out}`);
  }
  git("add", "-A");
  git("commit", "-q", "--no-verify", "-m", `proof: ${who} adds a tool, key, migration, fragment`);
}

const GATES = [
  ["check:changes", "bun", ["run", "check:changes"]],
  ["map:check", "bun", ["run", "map:check"]],
  ["docs:decisions-index:check", "bun", ["run", "docs:decisions-index:check"]],
  ["config schema --check", "bun", ["scripts/gen-config-schema.ts", "--check"]],
  ["migrations:embed:check", "bun", ["run", "migrations:embed:check"]],
  [
    "docgen:render --check",
    "bun",
    ["run", "--cwd", "packages/server", "docgen:render", "--", "--check"],
  ],
  ["docgen:facts-check", "bun", ["run", "--cwd", "packages/server", "docgen:facts-check"]],
  [
    "registry vs registered-tools.txt + migrations manifest",
    "node",
    [
      "./node_modules/vitest/vitest.mjs",
      "run",
      "test/tool-count.test.ts",
      "test/tool-facade-domain-coverage.test.ts",
      "test/migrations-manifest.test.ts",
    ],
    "packages/server",
  ],
];

function gatesOn(label) {
  let failed = 0;
  for (const [name, cmd, args, cwd] of GATES) {
    const r = spawnSync(cmd, args, { cwd: cwd ? join(WT, cwd) : WT, env, encoding: "utf8" });
    const ok = r.status === 0;
    const tail = `${r.stdout}${r.stderr}`.trim().split("\n").slice(-2).join(" | ").slice(0, 200);
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}: ${name}${ok ? "" : `\n      ${tail}`}`);
    if (!ok) failed++;
  }
  return failed;
}

function mergeOrder(first, second, label) {
  git("checkout", "-q", "-b", label, BASE);
  let conflicted = false;
  for (const b of [first, second]) {
    try {
      git("merge", "--no-edit", "--no-ff", "-q", b);
    } catch (e) {
      conflicted = true;
      console.log(`  [FAIL] ${label}: merging ${b} conflicted:\n${e.stdout}${e.stderr}`);
      git("merge", "--abort");
      return { conflicted };
    }
  }
  const markers = git("grep", "-lE", "^(<<<<<<<|>>>>>>>) ", "--", ".").trim();
  // Only tracked text that could carry a real marker; the merge-driver tests quote markers in prose.
  const real = markers.split("\n").filter((f) => f && !/\.(test\.[mc]?[jt]s|md)$/.test(f));
  console.log(
    `  [${real.length === 0 ? "PASS" : "FAIL"}] ${label}: merged both without conflict; ${real.length} file(s) with markers`,
  );
  return { conflicted: real.length > 0, tree: git("rev-parse", "HEAD^{tree}").trim() };
}

let failures = 0;
try {
  console.log(`base ${BASE.slice(0, 8)}; worktree ${WT}`);
  setup();
  makeBranch("proof/a", "alpha");
  git("checkout", "-q", "--detach", BASE);
  makeBranch("proof/b", "beta");
  git("checkout", "-q", "--detach", BASE);

  const ab = mergeOrder("proof/a", "proof/b", "proof/merge-ab");
  if (ab.conflicted) failures++;
  else failures += gatesOn("a then b");

  git("checkout", "-q", "--detach", BASE);
  const ba = mergeOrder("proof/b", "proof/a", "proof/merge-ba");
  if (ba.conflicted) failures++;
  else failures += gatesOn("b then a");

  if (ab.tree && ba.tree) {
    const same = ab.tree === ba.tree;
    console.log(
      `  [${same ? "PASS" : "FAIL"}] both merge orders produce the identical tree ${ab.tree.slice(0, 12)}`,
    );
    if (!same) failures++;
  }
} catch (e) {
  console.error(`proof setup failed: ${e.stack ?? e}`);
  failures++;
} finally {
  if (KEEP) console.log(`kept worktree at ${WT}`);
  else {
    spawnSync("git", ["worktree", "remove", "--force", WT], { cwd: REPO });
    rmSync(join(WT, ".."), { recursive: true, force: true });
    for (const b of ["proof/a", "proof/b", "proof/merge-ab", "proof/merge-ba"]) {
      spawnSync("git", ["branch", "-D", b], { cwd: REPO });
    }
  }
}
console.log(failures === 0 ? "two-branch proof: OK" : `two-branch proof: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
