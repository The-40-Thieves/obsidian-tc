// docgen — region application modes. Generated content is NOT committed: a filled region is a wall
// of lines (tool names, counts, config rows) that every tool- or config-adding PR rewrote, so any
// two such PRs conflicted on it. The regions are committed canonical-EMPTY and filled at build time.
//
//   fill   (default)  write every region's rendered content in place (docs build, wiki publish)
//   reset             empty every region back to its committed, canonical form
//   check             assert every committed region is canonical-EMPTY and every target RENDERS
//                     non-empty (a broken extractor fails here, not silently in the published docs)
//
// Pure over an injected reader/writer so the contract is unit-testable without touching the tree.
import { injectGenerated, isCanonicalEmpty } from "./inject";

export type RegionMode = "fill" | "reset" | "check";

export interface RegionTarget {
  /** Repo-relative path, for messages. */
  rel: string;
  /** Path handed to the reader/writer. */
  file: string;
  marker: string;
  /** What the extractor+renderer produced for this region. */
  content: string;
}

export interface RegionIO {
  read(file: string): string;
  write(file: string, text: string): void;
}

export interface RegionResult {
  /** Human-readable failures. Non-empty means the run failed (check/any mode). */
  problems: string[];
  /** `rel::marker` of every region whose bytes changed (fill/reset only). */
  changed: string[];
}

export function applyRegions(
  mode: RegionMode,
  targets: readonly RegionTarget[],
  io: RegionIO,
): RegionResult {
  const problems: string[] = [];
  const changed: string[] = [];
  for (const t of targets) {
    const id = `${t.rel} (marker: ${t.marker})`;
    // Every mode: a target that renders nothing means its extractor is broken, and reset/check
    // would otherwise report success while the published page comes out blank.
    if (t.content.trim() === "") {
      problems.push(`${id}: rendered EMPTY — the extractor/renderer is broken, not the doc`);
      continue;
    }
    let before: string;
    let after: string;
    try {
      before = io.read(t.file);
      if (mode === "check") {
        if (!isCanonicalEmpty(before, t.marker)) {
          problems.push(
            `${id}: committed region is FILLED — generated content must not be committed. ` +
              "Run `bun run docgen:render -- --reset` and commit the emptied region.",
          );
        }
        continue;
      }
      after = injectGenerated(before, t.marker, mode === "fill" ? t.content : "");
    } catch (e) {
      problems.push(`${id}: ${(e as Error).message}`);
      continue;
    }
    if (after === before) continue;
    io.write(t.file, after);
    changed.push(`${t.rel}::${t.marker}`);
  }
  return { problems, changed };
}
