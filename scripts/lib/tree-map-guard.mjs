// What `map:check` refuses: generated structural-map content that got committed. The numbers in it
// (scale, per-subsystem counts, largest files, import edges) depend on the whole tree, so a
// committed copy conflicts between ANY two PRs that touch a source file. Pure, for unit tests.

export const GENERATED_MARKER = /<!--\s*BEGIN GENERATED:/;
/** Paths that hold generated output and must never be tracked. */
export const FORBIDDEN_TRACKED = [/^generated\//, /^docs\/dependency-graph\.json$/];

/** @returns {string[]} human-readable problems; empty when clean. */
export function committedGeneratedProblems({ treeText, tracked }) {
  const problems = [];
  const lines = treeText.split("\n");
  lines.forEach((line, i) => {
    if (GENERATED_MARKER.test(line)) {
      problems.push(
        `TREE.md:${i + 1} carries a GENERATED region — derived numbers belong in generated/tree-map.md (bun run map), not in git`,
      );
    }
  });
  for (const path of tracked) {
    if (FORBIDDEN_TRACKED.some((re) => re.test(path))) {
      problems.push(`${path} is tracked — it is generator output and must stay untracked`);
    }
  }
  return problems;
}
