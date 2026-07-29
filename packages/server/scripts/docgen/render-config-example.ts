// docgen — defaulted-config example renderer (THE-470 item 3). Renders the "full shape (all
// defaults shown)" JSON block in docs/src/content/docs/configuration/config-yaml.md.
//
// WHY THIS EXISTS: that block was hand-maintained, and a page titled "the complete option surface"
// had drifted badly. Measured 2026-07-28 against `main` @ cd61e6f — FIVE entire defaulted blocks
// were absent from it:
//
//   indexing              (4 keys)   ranking.metadataPrior  (3 keys)
//   retrieval.cache       (3 keys)   retrieval.adaptiveRrf  (3 keys)
//   maintenance retention (4 keys)
//
// THE-598 named this page one of its worst dead-config-key clusters for exactly this reason: it is
// hand-maintained. Deriving the block from the schema is the fix; editing the JSON by hand would
// only re-drift on the next defaulted key.
//
// SCOPE — defaults only, deliberately. `ServerConfigSchema.parse()` returns what the server
// actually materialises from a minimal input, so every key here is a real default a reader can
// rely on. Keys that are `.optional()` (toolVisibility, the vaults[] sub-blocks) are NOT defaults
// and are absent by design; the prose sections below the block and the generated table in
// config-reference.md both cover them. Including them here would put illustrative values next to
// real defaults with nothing marking which is which — the confusion this block already caused.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";

/**
 * The one hand-written input: a minimal vault, since `vaults` has no default (min 1) and the
 * schema cannot invent a path. Everything else in the rendered block is the schema's own output.
 */
const SEED = {
  vaults: [{ id: "main", name: "My Vault", path: "/absolute/path/to/vault" }],
};

export function renderConfigExample(): string {
  const defaults = ServerConfigSchema.parse(SEED);
  const json = JSON.stringify(defaults, null, 2);
  return [
    "```json",
    json,
    "```",
    "",
    "Every value above is the schema's own default, materialised by parsing a config containing " +
      "nothing but the `vaults` entry — so this is literally what the server fills in for you. " +
      "`vaults[]` is the only block with no default: it needs a real path.",
    "",
    "Keys that are **optional** rather than defaulted — `toolVisibility` and the `vaults[]` " +
      "sub-blocks (`acl`, `bridges`, `plugins`, `commands`, `memory`, `workspace`) — are absent " +
      "here on purpose. They are documented in the sections below and in the " +
      "[Configuration Reference](/configuration/config-reference/) table.",
  ]
    .join("\n")
    .trimEnd();
}
