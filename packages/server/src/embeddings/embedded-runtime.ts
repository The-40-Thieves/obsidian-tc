// Unpacks the native files a compiled standalone binary carries for the local embedder
// (onnxruntime-node's binding + the onnxruntime library), so the binding can be dlopen'ed from a real
// directory: a native addon cannot be loaded from inside the executable, and it finds libonnxruntime
// next to itself. providers/local-embedder-registry.ts calls this with the files embedded-embedder.ts
// (generated at compile time by scripts/build-binary.ts) carries; outside a compiled binary nothing here runs.
//
// The directory is a per-content cache under the server's cacheDir, not a per-process temp dir like
// the sqlite-vec extension (search/vec.ts): these are 25-45 MB and unpacking them on every start
// would cost more than the model load that follows. A cached file is trusted only after its SHA-256
// matches the embedded one, so a tampered or half-written cache is replaced, never loaded.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export interface EmbeddedRuntimeFile {
  /** The file's final name in the runtime directory (the binding loads its library by this name). */
  name: string;
  /** Path of the gzipped bytes inside the executable (a `/$bunfs/...` path, readable with fs). */
  asset: string;
  /** SHA-256 (hex) of the UNcompressed bytes. */
  sha256: string;
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function isVerified(path: string, sha256: string): boolean {
  try {
    return existsSync(path) && sha256Hex(readFileSync(path)) === sha256;
  } catch {
    return false;
  }
}

/** Unpacks `files` into `<cacheDir>/runtime/onnxruntime-<content key>/` (skipping any already there
 *  and verified) and returns that directory. Throws if an embedded asset does not match its hash. */
export function extractEmbeddedRuntime(opts: {
  cacheDir: string;
  files: readonly EmbeddedRuntimeFile[];
}): string {
  const key = sha256Hex(Buffer.from(opts.files.map((f) => `${f.name}:${f.sha256}`).join("\n")));
  const dir = join(opts.cacheDir, "runtime", `onnxruntime-${key.slice(0, 16)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of opts.files) {
    const target = join(dir, f.name);
    if (isVerified(target, f.sha256)) continue;
    const bytes = gunzipSync(readFileSync(f.asset));
    if (sha256Hex(bytes) !== f.sha256) {
      throw new Error(`embedded runtime file ${f.name} does not match its recorded checksum`);
    }
    // Written beside the target and renamed in, so a concurrent start never sees a partial file.
    const staging = `${target}.${process.pid}.tmp`;
    writeFileSync(staging, bytes, { mode: 0o755 });
    try {
      renameSync(staging, target);
    } catch (e) {
      // Windows refuses to replace a library another process has mapped; if that process left a
      // verified copy there, it is the file we wanted.
      if (!isVerified(target, f.sha256)) throw e;
    }
    chmodSync(target, 0o755);
  }
  return dir;
}
