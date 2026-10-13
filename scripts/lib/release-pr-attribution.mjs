/**
 * Attribute user-visible commits to PRs, leaving commits with no recoverable PR as orphans.
 * `notUserVisible` accepts the release gate's PR-number and abbreviated-SHA exemptions.
 */
export function attributeReleasePrs(commits, prOfCommit, notUserVisible = new Map()) {
  const prs = new Set();
  const orphans = [];
  for (const commit of commits) {
    if (notUserVisible.has(commit.sha.slice(0, 8))) continue;
    const viaMerge = prOfCommit.get(commit.sha);
    if (viaMerge) {
      prs.add(viaMerge);
      continue;
    }
    const inline = [...commit.subject.matchAll(/\(#(\d+)\)/g)].map((match) => match[1]);
    if (inline.length) {
      for (const number of inline) prs.add(number);
      continue;
    }
    orphans.push(commit);
  }
  return { prs, orphans };
}
