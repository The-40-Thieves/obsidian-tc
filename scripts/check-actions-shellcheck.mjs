#!/usr/bin/env node
/**
 * check-actions-shellcheck (THE-940 review finding N2) — ci-security.yml's `actionlint` job runs
 * bare `actionlint -color`, which only globs workflow files under `.github/workflows`. actionlint
 * has no composite-action mode (pointing it at an action.yml directly parses it AS a workflow and
 * reports `"jobs" section is missing`), so every `action.yml` under `.github/actions` — including
 * the run: blocks the THE-940 `install-mcp-publisher` action introduced — sat entirely outside
 * that gate. Proven, not assumed: a textbook SC2086 was appended to that action and the exact bare
 * `actionlint -color` CI runs still exited 0.
 *
 * This gate closes the hole without re-duplicating the pinned mcp-publisher version/checksum back
 * into two workflow files (which is what M1 removed): it extracts every composite action's `run:`
 * block-scalar body — the same line-based technique check-workflow-injection.mjs uses, since
 * neither script needs a YAML parser to find a block scalar's indentation-delimited body — and
 * runs each one through `shellcheck` directly, the same tool actionlint's own shellcheck
 * integration already applies to every workflow-embedded run: block. Composite actions are held to
 * the identical bar workflows already are; nothing about that bar is invented here.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Extract every `run:` block-scalar body from a composite action's YAML text, dedented to column
 * 0. Pure and filesystem-free so it is directly testable. The block-scalar-by-indentation loop
 * mirrors check-workflow-injection.mjs's own extraction; the dedent amount is deliberately the
 * block's OWN first content line's indent, not the `run:` key's indent — those differ whenever
 * (as is universal in this repo's style) the body sits two spaces deeper than its key, and slicing
 * by the key's indent alone would leave every extracted line with leftover leading whitespace.
 * Inline `run: cmd` forms are skipped as not worth a synthetic one-line script — every step this
 * gate exists for uses a block scalar. Returns `[{ startLine, script }]`, `startLine` being the
 * first line of the script body (1-based, for a readable failure message).
 */
export function extractRunBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let runIndent = null; // indent of the `run:` key line itself — an upper bound on the body
  let contentIndent = null; // indent of the block's own first non-blank line — the real dedent
  let current = null;
  const indentOf = (s) => s.match(/^[ \t]*/)[0].length;

  for (const [i, line] of lines.entries()) {
    if (runIndent !== null) {
      if (line.trim() !== "" && indentOf(line) <= runIndent) {
        blocks.push(current);
        current = null;
        runIndent = null;
        contentIndent = null;
      } else {
        if (contentIndent === null && line.trim() !== "") contentIndent = indentOf(line);
        const cut = contentIndent === null ? line.length : Math.min(contentIndent, line.length);
        current.script += `${line.slice(cut)}\n`;
        continue;
      }
    }

    const key = line.match(/^[ \t]*(?:-[ \t]+)?run:[ \t]*(.*)$/);
    if (!key) continue;
    const rest = key[1].trim();
    if (/^[|>][-+]?\d*$/.test(rest)) {
      runIndent = indentOf(line);
      current = { startLine: i + 2, script: "" };
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function main() {
  const files = execFileSync("git", ["ls-files", ".github/actions"], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /\.ya?ml$/.test(l));

  // An empty scan must never read as a pass (THE-544's rule, applied here too): if the file list
  // or the block extraction comes back empty, that is the scanner being broken, not a clean repo.
  if (files.length === 0) {
    console.error(
      "check-actions-shellcheck: found 0 composite action file(s) under .github/actions — " +
        "expected at least one (install-mcp-publisher). The scanner is broken, not the repo clean.",
    );
    process.exit(1);
  }

  const tmp = mkdtempSync(join(tmpdir(), "actions-shellcheck-"));
  let blockCount = 0;
  const problems = [];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const blocks = extractRunBlocks(text);
    blocks.forEach((block, idx) => {
      blockCount += 1;
      const scriptPath = join(tmp, `${file.replace(/[/.]/g, "_")}-${idx}.sh`);
      // GitHub Actions expands `${{ ... }}` into the script TEXT before the shell ever runs — it
      // is never shell syntax. Fed verbatim, shellcheck misreads it as an attempted (and invalid)
      // parameter expansion and reports SC2296 on perfectly valid, pre-existing code (measured:
      // setup-rust/action.yml's `${{ github.workspace }}`). actionlint's own shellcheck
      // integration neutralizes the same construct before checking workflow run: blocks; this
      // does the equivalent for composite actions by substituting each expression with an inert
      // placeholder token that carries no shell metacharacters, so quoting/word-splitting checks
      // around it still run normally.
      const shellcheckable = block.script.replace(/\$\{\{[^}]*\}\}/g, "GHA_EXPR_PLACEHOLDER");
      writeFileSync(scriptPath, `#!/usr/bin/env bash\n${shellcheckable}`);
      try {
        execFileSync("shellcheck", ["-s", "bash", scriptPath], { encoding: "utf8" });
      } catch (err) {
        problems.push(
          `${file} (run: block starting at line ${block.startLine}):\n${err.stdout ?? err.message}`,
        );
      }
    });
  }

  if (blockCount === 0) {
    console.error(
      `check-actions-shellcheck: parsed ${files.length} file(s) and found 0 run: block(s) — ` +
        "expected at least one. The scanner is broken, not the repo clean.",
    );
    process.exit(1);
  }

  if (problems.length > 0) {
    console.error("check-actions-shellcheck: FAIL\n");
    for (const p of problems) console.error(p);
    process.exit(1);
  }

  console.log(
    `check-actions-shellcheck: OK (${files.length} composite action file(s), ${blockCount} ` +
      "run: block(s), shellcheck clean)",
  );
}

// Importing this module (as its test file does) must have no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
