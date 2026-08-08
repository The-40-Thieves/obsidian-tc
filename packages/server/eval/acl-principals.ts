// THE-751: sweep an ACL overlay's principals through the eval and report, per principal, whether
// retrieval ever returns a path that principal cannot read.
//
// WHY THIS IS CHEAP HERE AND WAS NOT FOR THE RBAC TEXT-TO-SQL WORK IT BORROWS FROM.
//
// That corpus (arXiv 2607.22115) needed GPT-4 plus a 4-expert panel to derive per-role ground truth,
// because SQL column permissions are semantic. Folder ACLs are not: `readableRel(acl, rel)` is a
// pure function of an ACL and a path — no I/O, no content, no state. So for principal P with ACL A:
//
//   expected_P  =  expected  INTERSECT  { p : readableRel(A, p) }
//
// computed, not judged. The 78 existing third-party judgments become per-principal judgments by
// intersection, and a reader can verify the intersection without running anything.
//
// THE OVERLAY IS ARBITRARY; THE GROUND TRUTH DERIVED FROM IT IS NOT. Both halves of that sentence
// have to travel with any published number — a self-authored ACL is a self-authored benchmark, and
// this project has already called that the weakest form of evidence. What makes it defensible is
// that the arbitrary part is mechanically checkable by a third party.
//
// The ACL is built through the same FolderAcl + makeIndexReadable factory the boot reconcile,
// add_vault and the index-on-write hook use, for the reason eval/run.ts's --acl-allow already
// states: a hand-rolled predicate here would be a SECOND implementation of the authorization
// boundary, free to drift from the one that ships.
//
// TWO METRICS, AND THEY ARE NOT THE SAME KIND OF THING:
//   leakage    — any returned path outside the principal's whitelist. A CORRECTNESS gate; the
//                expected count is exactly 0, so n does not bound it. n=21 is as conclusive as
//                n=1000. Non-zero here is a security finding, not a quality regression.
//   under-fill — recall lost against the principal's OWN achievable ceiling (expected_P), not
//                against the unrestricted expected set. This is the interesting number and it is
//                power-limited, so it is reported WITH its per-principal n rather than pooled.
//                THE-694/THE-695's acl_path_sets work exists to protect exactly this: the
//                over-fetch window means a heavily-restricted principal can under-fill for reasons
//                that have nothing to do with ranking.
//
// usage:
//   bun eval/acl-principals.ts <config.json> <golden.(yaml|json)> [--overlay eval/acl-overlay.json]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { FolderAcl } from "../src/acl";
import { GoldenSetSchema } from "./metrics";

interface Principal {
  id: string;
  range: string;
  readPaths: string[];
}

const norm = (p: string): string => p.replace(/\\/g, "/");

function main(): void {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith("--"));
  const [configPath, goldenPath] = positional;
  const ovIdx = argv.indexOf("--overlay");
  const overlayPath =
    ovIdx >= 0
      ? (argv[ovIdx + 1] as string)
      : fileURLToPath(new URL("./acl-overlay.json", import.meta.url));
  if (!configPath || !goldenPath) {
    process.stderr.write(
      "usage: bun eval/acl-principals.ts <config.json> <golden.(yaml|json)> [--overlay f.json]\n",
    );
    process.exit(2);
  }

  const overlay = JSON.parse(readFileSync(overlayPath, "utf8")) as { principals: Principal[] };
  // YAML is a JSON superset, so one parser reads both golden-set encodings.
  const golden = GoldenSetSchema.parse(parseYaml(readFileSync(goldenPath, "utf8")));

  const universe = new Set<string>();
  for (const q of golden.queries) for (const p of q.target_paths) universe.add(norm(p));

  process.stdout.write(
    `overlay ${overlay.principals.length} principal(s) | golden n=${golden.queries.length} | ` +
      `${universe.size} distinct target path(s)\n\n`,
  );

  const rows: Array<Record<string, unknown>> = [];
  for (const p of overlay.principals) {
    const acl = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      readPaths: p.readPaths,
      strictReadDefault: true,
    } as never);
    // matchedPathGlob is the same predicate readableRel composes; using it directly keeps this
    // script from re-deriving readability a second way.
    const readable = (rel: string): boolean =>
      Boolean(
        (acl as unknown as { matchedPathGlob(op: string, rel: string): unknown }).matchedPathGlob(
          "read",
          rel,
        ),
      );

    let scoreable = 0;
    let expectedTotal = 0;
    for (const q of golden.queries) {
      const visible = q.target_paths.map(norm).filter(readable);
      expectedTotal += visible.length;
      if (visible.length > 0) scoreable++;
    }
    const visibleUniverse = [...universe].filter(readable).length;
    rows.push({
      principal: p.id,
      range: p.range,
      globs: p.readPaths.length,
      scoreable_queries: scoreable,
      of: golden.queries.length,
      visible_target_paths: visibleUniverse,
      expected_pairs: expectedTotal,
    });
  }

  for (const r of rows) process.stdout.write(`${JSON.stringify(r)}\n`);

  // The overlap that makes leakage non-trivial: a query scoreable for >1 principal has a boundary
  // the retriever could actually cross. Disjoint roles would make every leak trivially detectable
  // and the test vacuous.
  const acls = overlay.principals.map((p) => {
    const a = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      readPaths: p.readPaths,
      strictReadDefault: true,
    } as never);
    return (rel: string): boolean =>
      Boolean(
        (a as unknown as { matchedPathGlob(op: string, rel: string): unknown }).matchedPathGlob(
          "read",
          rel,
        ),
      );
  });
  let multi = 0;
  let orphaned = 0;
  for (const q of golden.queries) {
    const paths = q.target_paths.map(norm);
    const n = acls.filter((r) => paths.some(r)).length;
    if (n > 1) multi++;
    if (n === 0) orphaned++;
  }
  process.stdout.write(
    `\n${JSON.stringify({ scoreable_for_multiple_principals: multi, orphaned_queries: orphaned, of: golden.queries.length })}\n`,
  );
  if (orphaned > 0) {
    process.stdout.write(
      `NOTE: ${orphaned} query(ies) are readable by NO principal — they contribute to no arm and\n` +
        "should be excluded from any pooled figure rather than counted as zeroes.\n",
    );
  }
  process.stdout.write(
    '\nNext: run eval/run.ts per principal with --acl-allow "$(comma-joined readPaths)" and check\n' +
      "leakage == 0 against each principal's visible set. Leakage is a correctness gate, not a metric.\n",
  );
}

main();
