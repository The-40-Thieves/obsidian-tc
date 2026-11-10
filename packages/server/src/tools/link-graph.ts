// The readable note graph: one pass over the notes a caller may read, links resolved through the
// shared vault index. Shared by the link-health tools and the lint_wiki cycles check.
import type { FolderAcl } from "../acl";
import type { ScanSteps } from "../util/scan-steps";
import { buildVaultIndex, resolveTarget } from "../vault/links";
import { ScanWarnings } from "./scan-warnings";
import { isExternal, linksOf, readableNotesSteps } from "./wiki-scan";

export interface LinkGraph {
  notes: string[];
  out: Map<string, Set<string>>;
  inn: Map<string, Set<string>>;
  unresolved: number;
  links: number;
  /** Notes whose frontmatter YAML did not parse (their bodies were still scanned). */
  warnings: ScanWarnings;
}

/** One step per note, so a handler drains it with `drainYielding` and the event loop stays free. */
export function* buildLinkGraphSteps(
  root: string,
  acl: FolderAcl | undefined,
  grantedScopes: Iterable<string>,
): ScanSteps<LinkGraph> {
  const notes = yield* readableNotesSteps(root, acl, grantedScopes);
  const index = buildVaultIndex(notes);
  const out = new Map<string, Set<string>>();
  const inn = new Map<string, Set<string>>();
  for (const p of notes) {
    out.set(p, new Set());
    inn.set(p, new Set());
  }
  let unresolved = 0;
  let links = 0;
  const warnings = new ScanWarnings();
  for (const p of notes) {
    for (const l of linksOf(root, p, warnings)) {
      if (l.inCodeblock) continue;
      if (isExternal(l.kind, l.target)) continue;
      if (l.target === "" || l.target.startsWith("#")) continue;
      links++;
      const r = resolveTarget(index, l.target);
      if (r.resolved && r.target_path && r.target_path !== p) {
        out.get(p)?.add(r.target_path);
        inn.get(r.target_path)?.add(p);
      } else if (!r.resolved) {
        unresolved++;
      }
    }
    yield;
  }
  return { notes, out, inn, unresolved, links, warnings };
}

/** The graph restricted to the notes in `keep`: other members, and edges to them, are gone. */
export function restrictGraph(
  out: Map<string, Set<string>>,
  keep: ReadonlySet<string>,
): Map<string, Set<string>> {
  const scoped = new Map<string, Set<string>>();
  for (const [p, targets] of out) {
    if (!keep.has(p)) continue;
    scoped.set(p, new Set([...targets].filter((t) => keep.has(t))));
  }
  return scoped;
}
