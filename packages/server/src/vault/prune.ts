// Hub-link pruning policy. A "hub" / map-of-content note accumulates links; this
// removes the ones a policy marks stale: unresolved (dangling) links and/or
// duplicate links to a target already linked earlier in the note. Fenced code is
// skipped. When removing a link leaves its line as only a list bullet / blank, the
// whole line is dropped (the common MOC bullet-list case); otherwise the link
// token is replaced by its display text (or removed). External URLs are kept.
import { resolveTarget, type VaultIndex } from "./links";

const FENCE = /^\s*(```|~~~)/;
// One alternation so wikilinks and markdown links are visited left-to-right in a
// single pass: g1/g2 = wikilink bang/inner, g3/g4/g5 = markdown bang/display/url.
const LINK = /(!?)\[\[([^\]\n]+?)\]\]|(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;
const BULLET_ONLY = /^[\s>*+-]*$/;

export type PruneReason = "unresolved" | "duplicate";
export interface PruneResult {
  text: string;
  removed: Array<{ target: string; line: number; reason: PruneReason }>;
}

export interface PrunePolicy {
  removeUnresolved: boolean;
  removeDuplicates: boolean;
}

export function pruneHubLinks(raw: string, index: VaultIndex, policy: PrunePolicy): PruneResult {
  const crlf = raw.includes("\r\n");
  const lines = raw.split(/\r?\n/);
  const seen = new Set<string>();
  const removed: PruneResult["removed"] = [];
  let fenced = false;
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) {
      fenced = !fenced;
      out.push(line);
      continue;
    }
    if (fenced) {
      out.push(line);
      continue;
    }

    let removals = 0;
    const next = line.replace(
      LINK,
      (full, wBang: string, wInner: string, mBang: string, mDisp: string, mUrl: string) => {
        const isWiki = wInner !== undefined;
        let target: string;
        let display: string | null;
        let kind: "wikilink" | "embed" | "markdown";
        if (isWiki) {
          const pipe = wInner.indexOf("|");
          display = pipe >= 0 ? wInner.slice(pipe + 1).trim() : null;
          const beforePipe = pipe >= 0 ? wInner.slice(0, pipe) : wInner;
          const hash = beforePipe.indexOf("#");
          target = (hash >= 0 ? beforePipe.slice(0, hash) : beforePipe).trim();
          kind = wBang === "!" ? "embed" : "wikilink";
        } else {
          target = (mUrl ?? "").trim();
          display = (mDisp ?? "").trim() || null;
          kind = mBang === "!" ? "embed" : "markdown";
        }

        const isExternalUrl = kind === "markdown" && /^[a-z]+:\/\//i.test(target);
        if (isExternalUrl) return full;

        const res = resolveTarget(index, target);
        if (!res.resolved) {
          if (policy.removeUnresolved) {
            removed.push({ target, line: i + 1, reason: "unresolved" });
            removals++;
            return display ?? "";
          }
          return full;
        }
        const path = res.target_path ?? target;
        if (seen.has(path)) {
          if (policy.removeDuplicates) {
            removed.push({ target, line: i + 1, reason: "duplicate" });
            removals++;
            return display ?? "";
          }
          return full;
        }
        seen.add(path);
        return full;
      },
    );

    if (removals === 0) out.push(line);
    else if (!BULLET_ONLY.test(next)) out.push(next);
    // else: the line collapsed to a bare bullet/blank — drop it
  }

  return { text: out.join(crlf ? "\r\n" : "\n"), removed };
}
