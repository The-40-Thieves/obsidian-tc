// The local embedder (@the-40-thieves/obsidian-tc-embedder-local) as a standalone binary carries it.
//
// EMPTY IN SOURCE CONTROL. `bun build --compile` embeds no assets and freezes import.meta.url, so a
// binary cannot find an optional package in node_modules the way the npm install does. scripts/
// build-binary.ts therefore REPLACES this module's contents at compile time (a Bun plugin; nothing
// is written to the tree) with one that bundles the embedder + Transformers.js + its selected ONNX
// runtime and embeds the target's native files or darwin-x64 WASM files (the registry unpacks them
// on first use through embedded-runtime.ts).
// Everywhere else (`bun run`, the npm dist build, every test) this stays undefined and resolution
// uses the package lookup in providers/local-embedder-registry.ts.
//
// A future target with neither a configured native runtime nor WASM fallback is compiled without
// it: undefined here, and "local" embeddings is unavailable in that binary.

import type { EmbeddedRuntimeFile } from "./embedded-runtime";

/** What a compiled binary carries: the runtime files to unpack, and the bundled embedder module. */
export interface EmbeddedEmbedderSpec {
  files: readonly EmbeddedRuntimeFile[];
  /** Imports the bundled embedder; call it only after the runtime files are unpacked. */
  load(): Promise<unknown>;
}

export const embeddedEmbedder: EmbeddedEmbedderSpec | undefined = undefined;

/** True only in a standalone binary built for a future target with no configured ONNX runtime:
 *  scripts/build-binary.ts replaces this module with `true` for that target. */
export const localEmbedderAbsentFromBinary: boolean = false;
