// Hub-link pruning policy. A "hub" / map-of-content note accumulates links; this
// removes the ones a policy marks stale: unresolved (dangling) links and/or
// duplicate links to a target already linked earlier in the note. Fenced code is
// skipped. When removing a link leaves its line as only a list bullet / blank, the
// whole line is dropped (the common MOC bullet-list case); otherwise the link
// token is replaced by its display text (or removed). External URLs are kept.
import { applyScanReplacements, scanLinks } from "./link-scan";
import { resolveTarget, type VaultIndex } from "./links";

const FENCE = /^\s*(```|~~~)/;
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
    const next = applyScanReplacements(line, scanLinks(line), (m) => {
      const full = m.raw;
      let target: string;
      let display: string | null;
      let kind: "wikilink" | "embed" | "markdown";
      if (m.kind === "wikilink") {
        // "\|" is the alias separator inside a table; split on it, not on the
        // raw pipe, so the backslash is not left on the target (GH #279).
        const pipeM = m.inner.match(/\\?\|/);
        display =
          pipeM?.index !== undefined ? m.inner.slice(pipeM.index + pipeM[0].length).trim() : null;
        const beforePipe = pipeM?.index !== undefined ? m.inner.slice(0, pipeM.index) : m.inner;
        const hash = beforePipe.indexOf("#");
        target = (hash >= 0 ? beforePipe.slice(0, hash) : beforePipe).trim();
        kind = m.bang ? "embed" : "wikilink";
      } else {
        target = m.url.trim();
        display = m.display.trim() || null;
        kind = m.bang ? "embed" : "markdown";
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
    });

    if (removals === 0) out.push(line);
    else if (!BULLET_ONLY.test(next)) out.push(next);
    // else: the line collapsed to a bare bullet/blank — drop it
  }

  return { text: out.join(crlf ? "\r\n" : "\n"), removed };
}
