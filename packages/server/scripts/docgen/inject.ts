// docgen — marker injection (THE-473). Replaces the content between a matched
//   <!-- BEGIN GENERATED: <name> -->  …  <!-- END GENERATED: <name> -->
// pair, leaving every byte outside the markers untouched. This is how generated reference blocks land
// in hand-authored files (README.md, ARCHITECTURE.md, the wiki pages) without clobbering the prose.
//
// Idempotent: injecting the same content twice is a no-op. Throws on a missing/mismatched marker pair
// so a doc that lost its markers fails loudly (in CI) rather than silently dropping generated content.

function markers(name: string): { begin: string; end: string } {
  return { begin: `<!-- BEGIN GENERATED: ${name} -->`, end: `<!-- END GENERATED: ${name} -->` };
}

/**
 * Replace the region between the named markers in `source` with `content`.
 * The markers themselves are preserved; a trailing/leading newline keeps the block readable.
 */
export function injectGenerated(source: string, name: string, content: string): string {
  const { begin, end } = markers(name);
  const b = source.indexOf(begin);
  const e = source.indexOf(end);
  if (b === -1 || e === -1) {
    throw new Error(`docgen: markers for "${name}" not found (need ${begin} … ${end})`);
  }
  if (e < b) {
    throw new Error(`docgen: END marker precedes BEGIN marker for "${name}"`);
  }
  const head = source.slice(0, b + begin.length);
  const tail = source.slice(e);
  const body = content.trim();
  return `${head}\n${body}\n${tail}`;
}

/** True when `source` carries a well-formed marker pair for `name`. */
export function hasMarkers(source: string, name: string): boolean {
  const { begin, end } = markers(name);
  const b = source.indexOf(begin);
  const e = source.indexOf(end);
  return b !== -1 && e !== -1 && e > b;
}
