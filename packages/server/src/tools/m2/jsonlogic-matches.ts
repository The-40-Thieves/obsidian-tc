import { evaluatesTruthy } from "../../search/jsonlogic";
import type { WalkReadable } from "../../vault/acl-read-filter";
import { walkVault } from "../../vault/paths";
import type { ReadRefusals } from "../read-refusals";
import type { ScanWarnings } from "../scan-warnings";

/** The vault notes (under `sub`, readable to the caller) whose frontmatter + { path, content } satisfy
 *  `logic`. A note the safe open refuses is skipped and counted in `refusals`. */
export function jsonlogicMatches(
  root: string,
  sub: string | undefined,
  readable: WalkReadable,
  logic: unknown,
  warnings: ScanWarnings,
  refusals: ReadRefusals,
): string[] {
  const out: string[] = [];
  for (const rel of walkVault(root, { sub, extensions: [".md"] })
    .filter((e) => readable(e.relPath, e.aclRel))
    .map((e) => e.relPath)) {
    const raw = refusals.read(root, rel);
    if (raw === null) continue;
    const { frontmatter, body } = warnings.parse(raw, rel);
    const data = { ...(frontmatter ?? {}), path: rel, content: body };
    if (evaluatesTruthy(logic, data)) out.push(rel);
  }
  return out;
}
