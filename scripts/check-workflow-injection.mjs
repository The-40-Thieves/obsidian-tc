#!/usr/bin/env node
// Fail the build if an attacker-controllable GitHub Actions context is expanded inside a `run:`
// block.
//
// WHY THIS EXISTS: `${{ ... }}` is expanded by the runner BEFORE the shell starts, so the value is
// pasted into the script as SOURCE TEXT, not passed as data. A value carrying a quote plus shell
// metacharacters escapes the surrounding command and executes on the runner, with the job's token
// and secrets.
//
// THE-541 was exactly this, in `.github/actions/setup-repo/action.yml` — and the irony is worth
// keeping: it sat in the error branch whose stated purpose was to "fail loudly on a typo", a
// defensive message that was itself the injection point.
//
// That instance was harmless in practice because every caller passed a literal. But as the ticket
// put it, that is "an invariant nothing enforces", and THE-505 is about to take that action from a
// handful of call sites toward every workflow. This is the enforcement.
//
// THE RULE: route the value through `env:` and reference it as a quoted shell variable.
//
//     env:
//       INSTALL_MODE: ${{ inputs.install-mode }}
//     run: echo "mode is '$INSTALL_MODE'"
//
// WHAT IS NOT FLAGGED: contexts whose values the workflow itself fixes — `matrix.*` (enumerated in
// the workflow), `runner.*`, `github.workspace`, `github.event_name`, and comparison/ternary
// expressions that evaluate to one of several literals spelled out in the file. Those cannot carry
// attacker text. Only the DENY list below is reported, so this stays actionable rather than noisy.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Contexts an outside party can influence. Sourced from GitHub's own script-injection guidance:
// anything derived from a PR/issue/comment body, a branch name, or a composite-action input (which
// a future caller may wire to any of the former).
const DENY = [
  /\binputs\./,
  /\bgithub\.event\./, // .event_name is safe and deliberately not matched (requires the dot)
  /\bgithub\.head_ref\b/,
  /\benv\.GITHUB_HEAD_REF\b/,
];

const EXPR = /\$\{\{([^}]*)\}\}/g;

const files = execFileSync("git", ["ls-files", ".github"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(ya?ml)$/.test(f));

const findings = [];
let runBlocks = 0;
let expressions = 0;

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  // Indent of the `run:` key while inside a block scalar; null when outside one.
  let runIndent = null;

  for (const [i, line] of lines.entries()) {
    const indentOf = (s) => s.match(/^[ \t]*/)[0].length;

    if (runIndent !== null) {
      // A blank line does not end a block scalar; a line indented no further than the key does.
      if (line.trim() !== "" && indentOf(line) <= runIndent) runIndent = null;
      else {
        check(file, i + 1, line);
        continue;
      }
    }

    const key = line.match(/^[ \t]*(?:-[ \t]+)?run:[ \t]*(.*)$/);
    if (!key) continue;
    runBlocks += 1;
    const rest = key[1].trim();
    if (/^[|>][-+]?\d*$/.test(rest) || rest === "") {
      // Block scalar: the body is every line indented past the `run:` key itself.
      runIndent = indentOf(line);
    } else {
      check(file, i + 1, rest); // inline `run: cmd`
    }
  }
}

function check(file, line, text) {
  for (const m of text.matchAll(EXPR)) {
    expressions += 1;
    const expr = m[1].trim();
    if (DENY.some((re) => re.test(expr))) {
      findings.push({ file, line, expr });
    }
  }
}

if (findings.length > 0) {
  console.error("check-workflow-injection: untrusted context expanded inside a run: block\n");
  for (const { file, line, expr } of findings) {
    console.error(`  ${file}:${line}  \${{ ${expr} }}`);
  }
  // Template literals with escaped placeholders: these strings intentionally contain Actions
  // `${{ }}` syntax, which reads as a JS template placeholder to a linter otherwise.
  console.error(
    `\n\`\${{ }}\` is expanded into the script TEXT before the shell runs, so a value carrying a` +
      `\nquote and shell metacharacters executes on the runner.` +
      `\n\nFix: pass it through \`env:\` and quote the variable —` +
      `\n  env:\n    MY_VALUE: \${{ inputs.whatever }}\n  run: echo "$MY_VALUE"\n`,
  );
  process.exit(1);
}

// An empty scan must never read as a pass (THE-544): if the parser stops finding run: blocks,
// the check would go quietly green over a repo full of them.
if (files.length === 0 || runBlocks === 0) {
  console.error(
    `check-workflow-injection: parsed ${files.length} file(s) and ${runBlocks} run: block(s) — ` +
      "expected many. The scanner is broken, not the repo clean.",
  );
  process.exit(1);
}

console.log(
  `check-workflow-injection: OK (${files.length} workflow files, ${runBlocks} run: blocks, ` +
    `${expressions} expansions, 0 untrusted)`,
);
