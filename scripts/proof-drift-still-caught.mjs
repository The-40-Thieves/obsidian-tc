#!/usr/bin/env node
// Drift-still-caught proof: moving generated content out of the committed tree must not have moved
// the gates that guard it out of reach. Each case plants ONE real drift in a throwaway worktree of
// the committed HEAD and requires the named gate to FAIL, then reverts it. The first line of each
// group is a control: the untouched tree passes that same gate, so a FAIL afterwards is caused by
// the plant and not by a gate that was already red.
//
//   node scripts/proof-drift-still-caught.mjs
//
// The planted strings are the ones that actually leaked in this repo's history (the stale
// "143 capabilities across 31 domains" in SKILLS.md, a filled marker region, a re-committed TREE.md
// region), not invented shapes.
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const BASE = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
const WT = join(mkdtempSync(join(tmpdir(), "drift-proof-")), "wt");
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "proof",
  GIT_AUTHOR_EMAIL: "proof@example.com",
  GIT_COMMITTER_NAME: "proof",
  GIT_COMMITTER_EMAIL: "proof@example.com",
};

const run = (cmd, args, cwd = WT) => {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const git = (...a) => run("git", a);
const edit = (rel, fn) => writeFileSync(join(WT, rel), fn(readFileSync(join(WT, rel), "utf8")));
const revert = () => {
  git("reset", "-q", "--hard", BASE);
  // -e node_modules: the symlinked installs are untracked and, being symlinks, not matched by a
  // `node_modules/` ignore rule, so a plain clean would delete them.
  git("clean", "-fdq", "-e", "node_modules");
};

const GATES = {
  facts: () => run("bun", ["run", "--cwd", "packages/server", "docgen:facts-check"]),
  render: () => run("bun", ["run", "--cwd", "packages/server", "docgen:render", "--", "--check"]),
  names: () =>
    run(
      "node",
      ["./node_modules/vitest/vitest.mjs", "run", "test/tool-count.test.ts"],
      join(WT, "packages/server"),
    ),
  schema: () => run("bun", ["scripts/gen-config-schema.ts", "--check", "--base", BASE]),
  map: () => run("bun", ["run", "map:check"]),
  embed: () => run("bun", ["run", "migrations:embed:check"]),
};

const CASES = [
  {
    gate: "facts",
    name: 'prose restates the tool count ("143 capabilities across 31 domains", the SKILLS.md leak)',
    plant: () =>
      appendFileSync(
        join(WT, "SKILLS.md"),
        "\nThe server has **143 capabilities across 31 domains**.\n",
      ),
  },
  {
    gate: "facts",
    name: 'prose restates the tool count ("167 tools across 31 domains")',
    plant: () => appendFileSync(join(WT, "README.md"), "\nIt ships 167 tools across 31 domains.\n"),
  },
  {
    gate: "render",
    name: "a docgen region committed FILLED (bun run docgen:render, then commit)",
    plant: () => {
      const r = run("bun", ["run", "--cwd", "packages/server", "docgen:render"]);
      if (!r.ok) throw new Error(`fill failed:\n${r.out}`);
    },
  },
  {
    gate: "names",
    name: "a registered tool's name removed from registered-tools.txt",
    plant: () =>
      edit("packages/server/test/registered-tools.txt", (t) => t.replace("read_note\n", "")),
  },
  {
    gate: "names",
    name: "a name added to registered-tools.txt with no such tool",
    plant: () =>
      edit("packages/server/test/registered-tools.txt", (t) => `${t}zzz_not_a_real_tool\n`),
  },
  {
    gate: "schema",
    name: "real Zod default change (snapshots.retention 10 -> 20), schema regenerated, no acknowledgement",
    plant: () => {
      edit("packages/shared/src/config/observability.schema.ts", (t) => {
        if (!t.includes(".default(10)")) throw new Error("anchor .default(10) missing");
        return t.replace(".default(10)", ".default(20)");
      });
      const r = run("bun", ["scripts/gen-config-schema.ts"]);
      if (!r.ok) throw new Error(`regen failed:\n${r.out}`);
    },
    // Same plant plus the acknowledgement must pass: the gate blocks the UNANNOUNCED change only.
    control: () =>
      writeFileSync(
        join(WT, "changes/ack.md"),
        "---\ntype: Changed\nconfig-schema-change: snapshots.retention\n---\n- **Retention default raised.** (#1)\n",
      ),
  },
  {
    gate: "map",
    name: "a generated region re-committed in TREE.md",
    plant: () =>
      appendFileSync(
        join(WT, "TREE.md"),
        "\n<!-- BEGIN GENERATED: scale -->\n| files | 1 |\n<!-- END GENERATED: scale -->\n",
      ),
  },
  {
    gate: "map",
    name: "generated/tree-map.md force-added to git",
    plant: () => {
      mkdirSync(join(WT, "generated"), { recursive: true });
      writeFileSync(join(WT, "generated/tree-map.md"), "# stale\n");
      git("add", "-f", "generated/tree-map.md");
    },
  },
  {
    gate: "embed",
    name: "a migration .sql added without regenerating migrations-embedded.ts",
    plant: () =>
      writeFileSync(
        join(WT, "packages/server/src/migrations/29990101_001_drift_probe.sql"),
        "-- probe\nCREATE TABLE IF NOT EXISTS drift_probe(id INTEGER PRIMARY KEY);\n",
      ),
  },
];

let failures = 0;
const line = (ok, text) => console.log(`  [${ok ? "PASS" : "FAIL"}] ${text}`);

try {
  console.log(`base ${BASE.slice(0, 8)}; worktree ${WT}`);
  execFileSync("git", ["worktree", "add", "--detach", WT, BASE], { cwd: REPO, env });
  for (const l of [
    "node_modules",
    ...readdirSync(join(REPO, "packages")).map((p) => `packages/${p}/node_modules`),
  ]) {
    if (existsSync(join(REPO, l))) {
      mkdirSync(dirname(join(WT, l)), { recursive: true });
      symlinkSync(join(REPO, l), join(WT, l));
    }
  }
  const controlled = new Set();
  for (const c of CASES) {
    if (!controlled.has(c.gate)) {
      controlled.add(c.gate);
      const r = GATES[c.gate]();
      line(r.ok, `control (${c.gate}): untouched tree passes`);
      if (!r.ok) failures++;
    }
    c.plant();
    const r = GATES[c.gate]();
    const signal =
      /(Error|error:|expected|missing|extra|STALE|FILLED|toolCount|changed:|committed|tracked)/;
    const detail = r.out
      .split("\n")
      .filter((l) => signal.test(l))
      .slice(0, 2)
      .map((l) => l.trim())
      .join(" | ")
      .slice(0, 260);
    line(!r.ok, `${c.gate} fails on: ${c.name}${r.ok ? "" : `\n        -> ${detail}`}`);
    if (r.ok) failures++;
    if (c.control) {
      c.control();
      const ack = GATES[c.gate]();
      line(ack.ok, `${c.gate} passes once the change is acknowledged in a changes/ fragment`);
      if (!ack.ok) failures++;
    }
    revert();
  }
} catch (e) {
  console.error(`drift proof errored: ${e.stack ?? e}`);
  failures++;
} finally {
  spawnSync("git", ["worktree", "remove", "--force", WT], { cwd: REPO });
  rmSync(join(WT, ".."), { recursive: true, force: true });
}
console.log(
  failures === 0
    ? "drift-still-caught proof: OK"
    : `drift-still-caught proof: ${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
