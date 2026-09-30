// docgen — per-tool page naming. One place decides the file/URL segment for a tool so the
// generator, the catalog links and the invariant check can never disagree about where a page lives.

/** Repo-relative directory the generator writes to (gitignored; rebuilt on every docs build). */
export const TOOL_PAGES_DIR = "docs/src/content/docs/tools/reference";
/** URL prefix the docs site serves the pages under (root-relative, matches Starlight's routing). */
export const TOOL_PAGES_URL_BASE = "/tools/reference/";

/** The page's file stem and URL segment. Tool names are snake_case; anything else could escape the
 *  output directory or slug differently in Starlight, so it fails loudly instead of being mangled. */
export function toolPageSlug(name: string): string {
  if (!/^[a-z0-9_-]+$/.test(name)) {
    throw new Error(`docgen: tool name "${name}" is unsafe as a page slug (want [a-z0-9_-]+)`);
  }
  return name;
}
