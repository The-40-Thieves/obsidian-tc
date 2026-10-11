// Compiles libsql-compile-smoke-entry.ts for the host with the libsql addon embedded (the same
// plugin scripts/build-binary.ts --with-libsql uses). `bun libsql-compile-smoke-build.ts <outfile>`.
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fetchLibsqlNative, libsqlBundlePlugin } from "../../../scripts/lib/libsql-bundle.mjs";

const outfile = process.argv[2];
if (!outfile) throw new Error("usage: libsql-compile-smoke-build.ts <outfile>");
const os = process.platform === "win32" ? "windows" : process.platform;
const target = `bun-${os}-${process.arch}`;
const server = resolve(import.meta.dir, "..");
const version = JSON.parse(
  readFileSync(join(server, "node_modules", "libsql", "package.json"), "utf8"),
).version;
const native = await fetchLibsqlNative(target, version, (m) => console.log(m));
try {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "libsql-compile-smoke-entry.ts")],
    compile: { target: target as Bun.Build.CompileTarget, outfile: resolve(outfile) },
    plugins: [libsqlBundlePlugin(native.nodeFile)],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    throw new Error("libsql-compile-smoke: bun build failed");
  }
} finally {
  rmSync(native.cleanupDir, { recursive: true, force: true });
}
