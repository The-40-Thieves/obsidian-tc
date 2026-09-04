// THE-734: build the shared_tag derived-edge set on an existing eval index, without a reindex.
//
// The tag half of eval/densify-index.ts, which only ever covered kNN. Same justification, same
// shape: `tagCooccurrenceEdges` + `reconcileDerivedEdges` are exactly what indexVault calls
// internally on a cold start (search/indexing/index-vault.ts's `countDerivedEdges(...) === 0`
// branch), so going direct runs the same code on the same inputs, minus a full vault walk that a
// sweep over edge parameters does not need — the notes and their tags do not change between cells.
//
// Without this, measuring tagEdges meant an indexVault reconcile per cell, which is the 48+ minute
// cost densify-index.ts's header documents and the reason that sweep looked infeasible.
//
// It DELETES the existing shared_tag edges before rebuilding, deliberately and for the same reason
// densify-index.ts does: with edges already present, a reconcile diffs against the previous cell's
// set rather than building this cell's, silently measuring the wrong configuration.
//
// maxTagFanout is an INDEX-time parameter — a tag on more notes than this is a hub, not a signal,
// and emits no edges at all, so it decides which edges exist and cannot be swept from the search
// side. derivedWeight (the search-side knob) stays an env var on eval/run.ts.
//
// usage:
//   bun eval/densify-tags-index.ts <config.json> [--fanout 25]
import { loadConfig } from "../src/config/load";
import { openConfiguredDatabase } from "../src/db/open";
import {
  countDerivedEdges,
  reconcileDerivedEdges,
  tagCooccurrenceEdges,
} from "../src/search/derived-edges";
import { readNoteTags } from "../src/search/indexing/note-plan";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const configPath = argv.find((a) => !a.startsWith("--"));
  const fanoutArg = argv.indexOf("--fanout");
  const maxTagFanout = fanoutArg >= 0 ? Number(argv[fanoutArg + 1]) : 25;
  if (!configPath || !Number.isFinite(maxTagFanout) || maxTagFanout < 1) {
    process.stderr.write("usage: bun eval/densify-tags-index.ts <config.json> [--fanout N]\n");
    process.exit(2);
  }
  const config = loadConfig(configPath);
  const vaultId = config.vaults[0]?.id ?? "main";
  const db = await openConfiguredDatabase(config, "cache.db");

  const before = countDerivedEdges(db, vaultId, "shared_tag");
  // Clear first — see the header. Reconciling against a non-empty set diffs, it does not rebuild.
  reconcileDerivedEdges(db, vaultId, [], ["shared_tag"], Date.now);
  process.stdout.write(`cleared ${before} existing shared_tag edge(s)\n`);

  const t0 = Date.now();
  const notesTags = readNoteTags(db, vaultId);
  const desired = tagCooccurrenceEdges(notesTags, { maxTagFanout });
  const stats = reconcileDerivedEdges(db, vaultId, desired, ["shared_tag"], Date.now);
  const elapsed = Date.now() - t0;

  let tagged = 0;
  for (const tags of notesTags.values()) if (tags.length > 0) tagged++;

  process.stdout.write(
    `${JSON.stringify({
      maxTagFanout,
      notes: notesTags.size,
      notes_tagged: tagged,
      edges: stats.desired,
      inserted: stats.inserted,
      deleted: stats.deleted,
      tags_ms: elapsed,
    })}\n`,
  );
  db.close?.();
}

void main();
