// PR B follow-up (VS Code/opencode/Windsurf/Zed/Gemini CLI/Devin/Aider): the JSONC-aware twin of
// `mergeMcpServersEntry` in client-install-types.ts. opencode's `opencode.json` and Zed's
// `settings.json` both document `//` comments in real example configs (opencode.ai/docs/config,
// zed.dev/docs/ai/mcp) — `JSON.parse`-then-`JSON.stringify` on either would silently DROP every
// comment and reformat the whole file, which this repo's own standing policy treats as a class of
// bug on its own ("never strip comments by parsing with JSON.parse and re-serialising a JSONC
// file"). `jsonc-parser` (Microsoft, github.com/microsoft/node-jsonc-parser, the VS Code team's own
// scanner/editor for this exact format) edits the TEXT in place: `modify` computes a minimal set of
// text edits for one path, `applyEdits` applies them — verified directly against its README before
// use (`npx ctx7@latest` has no listing for this package; its own README, fetched and exercised in
// a sandbox, is the primary source cited here).
// Imported from the explicit ESM subpath, NOT the bare `"jsonc-parser"` specifier: that package
// ships no `exports` map, so `bun build --target node` (packages/server's own `build` script)
// resolves the bare specifier to `package.json`'s `main` (the UMD bundle) instead of `module` (the
// ESM one) — and the UMD bundle's own `require("./impl/format")` etc. survive bundling as literal,
// unresolved runtime requires, since Bun's static bundler cannot see through UMD's
// `typeof exports === "object"` factory-detection wrapper. Reproduced directly: `bun run build` in
// packages/server, then `bun dist/cli.js <config>`, throws `Cannot find module './impl/format'`
// (dist/cli.js has no `impl/` alongside it — nothing shipped it there) — CI's `install-smoke` job
// (all 3 OS) and `zero-config-smoke`/`zero-config-smoke-local-embeddings` caught exactly this.
// Importing the ESM entry directly bypasses that ambiguous "main" resolution: it is plain
// `import`/`export` all the way down (verified: `lib/esm/main.js` imports `./impl/format` etc. with
// `import`, not `require`), which Bun's bundler DOES inline correctly, and unit tests (which run
// source, never the bundle) could not have caught this class of failure — the bundle is a build
// artifact this file has no other way to exercise short of running dist/cli.js itself.
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  type ParseError,
  parse,
  parseTree,
} from "jsonc-parser/lib/esm/main.js";
import { CliError } from "../cli-error";

export interface JsoncMergeResult {
  /** True when an `obsidian-tc` entry was ALREADY present and `force` was not set — `text` is then
   *  just the original, byte-for-byte unchanged. */
  alreadyExists: boolean;
  text: string;
}

const FORMATTING_OPTIONS = { tabSize: 2, insertSpaces: true, eol: "\n" } as const;
const PARSE_OPTIONS = { allowTrailingComma: true } as const;

/** Merge the obsidian-tc entry into an existing (or absent) JSONC config file's TEXT — pure, so
 *  every case (missing file, missing `serversKey`, existing entry, malformed JSON, a `serversKey`
 *  that is not an object) is unit-testable without touching a filesystem. Mirrors
 *  `mergeMcpServersEntry`'s own refusal shapes exactly, on text instead of a parsed object, so a
 *  future reader comparing the two functions finds the same decisions made the same way. */
export function mergeMcpServersEntryJsonc(
  existingText: string | undefined,
  entry: Record<string, unknown>,
  opts: { force?: boolean } = {},
  serversKey = "mcpServers",
): JsoncMergeResult {
  const text = existingText ?? "";
  if (text.trim().length > 0) {
    const errors: ParseError[] = [];
    parse(text, errors, PARSE_OPTIONS);
    if (errors.length > 0) {
      throw new CliError(
        "this client's config is not valid JSON/JSONC (parse error at offset " +
          `${errors[0]?.offset ?? "unknown"}) — fix or remove it, then re-run.`,
      );
    }
  }
  const tree = text.trim().length > 0 ? parseTree(text, undefined, PARSE_OPTIONS) : undefined;
  if (tree !== undefined) {
    const serversNode = findNodeAtLocation(tree, [serversKey]);
    // Same refusal as `mergeMcpServersEntry`'s finding 5: a present-but-wrong-shaped `serversKey`
    // (an array, a string, ...) must never be silently replaced.
    if (serversNode !== undefined && serversNode.type !== "object") {
      throw new CliError(
        `this client's config has a "${serversKey}" key that is not a JSON object (found ` +
          `${serversNode.type === "array" ? "an array" : serversNode.type}) — refusing to ` +
          "replace it. Fix the file by hand, then re-run.",
      );
    }
  }
  const existingEntryNode = tree
    ? findNodeAtLocation(tree, [serversKey, "obsidian-tc"])
    : undefined;
  const alreadyExists = existingEntryNode !== undefined;
  if (alreadyExists && !opts.force) {
    return { alreadyExists: true, text };
  }
  const edits = modify(text, [serversKey, "obsidian-tc"], entry, {
    formattingOptions: FORMATTING_OPTIONS,
  });
  return { alreadyExists: false, text: applyEdits(text, edits) };
}
