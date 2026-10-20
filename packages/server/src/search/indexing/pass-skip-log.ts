// The stderr lines a pass ends with: one sampled line per skip class (the count, then the first three
// paths), so a large vault cannot flood the log. Every failing path stays in the IndexStats arrays.
import type { IndexStats } from "./types";

function sampleLine(
  vaultId: string,
  count: number,
  failures: Array<{ path: string }>,
  reason: string,
): string {
  const sample = failures
    .slice(0, 3)
    .map((f) => f.path)
    .join(", ");
  return `[index] vault "${vaultId}": ${count} note(s) skipped: ${reason} (${sample}${count > 3 ? ", ..." : ""})\n`;
}

export function logPassSkips(vaultId: string, stats: IndexStats): void {
  if (stats.notes_frontmatter_failed > 0)
    process.stderr.write(
      sampleLine(
        vaultId,
        stats.notes_frontmatter_failed,
        stats.frontmatter_failures,
        "frontmatter is not valid YAML",
      ),
    );
  if (stats.notes_read_refused > 0)
    process.stderr.write(
      sampleLine(
        vaultId,
        stats.notes_read_refused,
        stats.read_refusals,
        "the safe open refused the read",
      ),
    );
}
