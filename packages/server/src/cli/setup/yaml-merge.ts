// PR C follow-up (Continue, Goose): the YAML-aware twin of `mergeMcpServersEntryJsonc` — Goose's
// own config-file docs (block.github.io/goose/docs/guides/config-file, now redirected to
// goose-docs.ai/docs/guides/config-file) show real operator comments in `~/.config/goose/
// config.yaml`, so re-serializing a plain parsed object would silently drop them, the same class of
// bug jsonc-merge.ts's own header names. The `yaml` package (already a dependency — see
// src/vault/frontmatter.ts's own use of its Document API for exactly this "edit in place, keep
// comments/anchors/formatting" reason) is used the same way here: `YAML.parseDocument` keeps the
// original text's comments and structure live on the returned `Document`, and `setIn`/`getIn`
// mutate/read it via a path array rather than round-tripping through a plain JS object. Verified
// directly (not assumed): `doc.setIn([...path, "reliquary-tc"], entry)` auto-creates any missing
// intermediate map (a config with no `extensions:` key yet still merges correctly), and a sibling
// key's own inline comment survives a `setIn` elsewhere in the same map.

import YAML from "yaml";
import { CliError } from "../cli-error";
import { LEGACY_SERVER_KEY, SERVER_KEY } from "./client-install-types";

export interface YamlMergeResult {
  /** True when a `reliquary-tc` entry was ALREADY present and `force` was not set — `text` is then
   *  just the original, byte-for-byte unchanged. */
  alreadyExists: boolean;
  text: string;
}

/** Merge the reliquary-tc entry into an existing (or absent) YAML config file's TEXT — pure, so
 *  every case (missing file, missing path, existing entry, malformed YAML, a path segment that is
 *  not a mapping) is unit-testable without touching a filesystem. Mirrors
 *  `mergeMcpServersEntryJsonc`'s own refusal shapes on text instead of a parsed object.
 *
 *  An EMPTY `serversPath` (Continue's per-server standalone file — see `YamlMergeClientSpec`'s own
 *  doc comment) is a different, simpler case: the whole file IS the entry, so "already exists"
 *  means the file already has content at all (there is no nested key to find), and a fresh write is
 *  just `entry` serialized as a brand-new document — nothing to preserve, since this file belongs
 *  to reliquary-tc alone by construction (a dedicated `reliquary-tc.yaml`, never shared with another
 *  server's own entry the way `extensions`/`mcpServers` maps are). */
export function mergeMcpServersEntryYaml(
  existingText: string | undefined,
  entry: Record<string, unknown>,
  opts: { force?: boolean } = {},
  serversPath: string[] = ["mcpServers"],
): YamlMergeResult {
  const text = existingText ?? "";

  if (serversPath.length === 0) {
    const alreadyExists = text.trim().length > 0;
    if (alreadyExists && !opts.force) {
      return { alreadyExists: true, text };
    }
    return { alreadyExists: false, text: `${new YAML.Document(entry).toString()}` };
  }

  let doc: YAML.Document;
  if (text.trim().length > 0) {
    doc = YAML.parseDocument(text);
    if (doc.errors.length > 0) {
      throw new CliError(
        `this client's config is not valid YAML (${doc.errors[0]?.message ?? "parse error"}) — ` +
          "fix or remove it, then re-run.",
      );
    }
  } else {
    doc = new YAML.Document({});
  }

  // Same refusal as `mergeMcpServersEntryJsonc`'s own: a present-but-wrong-shaped path segment (a
  // scalar, a sequence, ...) must never be silently replaced.
  const serversNode = doc.getIn(serversPath, true);
  if (serversNode !== undefined && !YAML.isMap(serversNode)) {
    throw new CliError(
      `this client's config has a "${serversPath.join(".")}" key that is not a YAML mapping — ` +
        "refusing to replace it. Fix the file by hand, then re-run.",
    );
  }

  const hasLegacy = doc.getIn([...serversPath, LEGACY_SERVER_KEY]) !== undefined;
  const alreadyExists = hasLegacy || doc.getIn([...serversPath, SERVER_KEY]) !== undefined;
  if (alreadyExists && !opts.force) {
    return { alreadyExists: true, text };
  }
  if (hasLegacy) doc.deleteIn([...serversPath, LEGACY_SERVER_KEY]);
  doc.setIn([...serversPath, SERVER_KEY], entry);
  return { alreadyExists: false, text: doc.toString() };
}
