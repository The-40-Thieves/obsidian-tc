// Acknowledgement rule for the advertised tool-description snapshot
// (packages/server/test/tool-descriptions.snapshot.json, `<surface>/<tool>` -> full description).
//
// claude.ai keys "Always allow" to a hash of the tool description, so editing one makes every user
// re-approve that tool. The staleness half (the live text must equal the committed snapshot) is a
// vitest suite; this is the half that needs the base branch: an entry whose text differs from the
// SAME file on the base ref must be named by `tool-description-change:` in a changes/ fragment.
// A new tool, or a removed one, is not a description change and needs nothing.
//
// A token acknowledges an entry when it equals the tool name (every surface carrying that tool) or
// the full `<surface>/<tool>` key. The `domain` surface is derived: a domain meta-tool's text lists
// every member as `- <tool>: <summary>`, so it moves whenever a member's first sentence moves or a
// member is added or removed. Such an entry is acknowledged when each line that differs is a member
// line whose tool is itself acknowledged, added or removed; a differing header line (the domain's own
// blurb) needs the domain's name (or `domain/<name>`).

const MEMBER_LINE = /^- ([a-z][a-z0-9_]*): /;

/** The tool name of an entry key (`flat/read_note` -> `read_note`). */
const toolOf = (key) => key.slice(key.indexOf("/") + 1);
const surfaceOf = (key) => key.slice(0, key.indexOf("/"));

/** Lines present in exactly one of the two texts (a multiset-free symmetric difference). */
function differingLines(a, b) {
  const as = a.split("\n");
  const bs = b.split("\n");
  const inA = new Set(as);
  const inB = new Set(bs);
  return [...as.filter((l) => !inB.has(l)), ...bs.filter((l) => !inA.has(l))];
}

/**
 * Entries of `head` whose description differs from `base` without acknowledgement.
 * @param {Record<string,string>} base snapshot at the base ref
 * @param {Record<string,string>} head snapshot in the working tree
 * @param {Iterable<string>} acknowledged tokens from every fragment's `tool-description-change:`
 * @returns {{ key: string, reason: string }[]}
 */
export function unacknowledgedDescriptionChanges(base, head, acknowledged) {
  const acked = new Set(acknowledged);
  const membership = new Set([
    ...Object.keys(head)
      .filter((k) => !(k in base))
      .map(toolOf),
    ...Object.keys(base)
      .filter((k) => !(k in head))
      .map(toolOf),
  ]);
  const bad = [];
  for (const key of Object.keys(head).sort()) {
    if (!(key in base) || base[key] === head[key]) continue;
    const tool = toolOf(key);
    if (acked.has(tool) || acked.has(key)) continue;
    if (surfaceOf(key) === "domain") {
      const lines = differingLines(base[key], head[key]);
      const uncovered = lines.filter((line) => {
        const member = MEMBER_LINE.exec(line)?.[1];
        return member === undefined || !(acked.has(member) || membership.has(member));
      });
      if (uncovered.length === 0) continue;
      bad.push({
        key,
        reason: `domain meta-tool text changed (name "${tool}", or each changed member line's tool, must be acknowledged)`,
      });
      continue;
    }
    bad.push({ key, reason: "description changed" });
  }
  return bad;
}
