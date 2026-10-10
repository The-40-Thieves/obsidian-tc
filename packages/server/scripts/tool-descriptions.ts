// Tool-description snapshot: `bun scripts/tool-descriptions.ts` checks it, `--update` rewrites it.
//
// claude.ai keys "Always allow" to a hash of the tool description, and Visual Studio resets
// approvals on list_changed, so editing a description makes every user re-approve that tool.
// test/tool-descriptions.snapshot.json holds the full advertised text per surface
// (`<surface>/<tool>`, sorted, one entry per line) so that change is reviewable in the diff.
//
// Two halves, mirroring the config-schema gate:
//   1. STALENESS (this script's check, and test/tool-description-snapshot.test.ts): the live
//      descriptions must equal the committed file.
//   2. ACKNOWLEDGEMENT (scripts/check-tool-description-acks.mjs, `--base origin/main`): an entry
//      that changed versus main must be named by `tool-description-change:` in the PR's
//      changes/ fragment.
import { readFileSync, writeFileSync } from "node:fs";
import { buildFullRegistry } from "./docgen/build-registry";
import {
  advertisedSurfaces,
  descriptionEntries,
  renderDescriptionSnapshot,
} from "./docgen/tool-surface";

const SNAPSHOT_URL = new URL("../test/tool-descriptions.snapshot.json", import.meta.url);

const live = renderDescriptionSnapshot(descriptionEntries(advertisedSurfaces(buildFullRegistry())));
const count = Object.keys(JSON.parse(live)).length;
if (process.argv.includes("--update")) {
  writeFileSync(SNAPSHOT_URL, live);
  process.stdout.write(
    `tool descriptions: wrote ${count} entries to test/tool-descriptions.snapshot.json\n` +
      "If any existing description changed, add `tool-description-change: <tool>[, <tool>]` to the " +
      "front matter of your changes/<slug>.md fragment.\n",
  );
} else {
  if (readFileSync(SNAPSHOT_URL, "utf8") !== live) {
    process.stderr.write(
      "tool descriptions: test/tool-descriptions.snapshot.json is stale. Run " +
        "`bun run tool-descriptions:update` in packages/server and commit the result.\n",
    );
    process.exit(1);
  }
  process.stdout.write(`tool descriptions: up to date (${count} entries)\n`);
}
