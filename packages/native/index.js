// Umbrella entry for @the-40-thieves/obsidian-tc-native (THE-215).
//
// Resolves the compiled napi-rs binary for the host: first a locally-built .node
// (source checkout / `napi build`), then the published platform package
// @the-40-thieves/obsidian-tc-native-<triple> (added to optionalDependencies by
// `napi prepublish` at publish time). When neither resolves -- an unsupported
// platform, a missing prebuild, or an install without the optional dep -- it falls
// back to the pure-JS implementation in ./fallback.js instead of throwing, so the
// module is always usable (G2.2 component 9). The JS fallback is numerically
// identical to the Rust (src/lib.rs).
//
// This hand-written loader intentionally replaces the napi-generated index.js (which
// throws when no binary is found). Real prebuild resolution is exercised per-platform
// at publish/runtime; a source checkout typically runs the JS fallback.

const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

// musl vs glibc detection (ported from napi-rs's generated loader). Alpine and other musl hosts
// must request the -musl prebuild, not -gnu. process.report is the primary signal because it
// reflects the libc the *running* process is linked against and is reliable on modern Node (glibc
// sets header.glibcVersionRuntime; musl does not and lists its loader in sharedObjects). Only when
// the report yields no decisive signal do we fall back to the /usr/bin/ldd text, then
// `ldd --version`. Unknown => false (glibc is the safe default; a wrong guess still degrades to the
// JS fallback).
const isFileMusl = (f) => f.includes("libc.musl-") || f.includes("ld-musl-");

function isMuslFromFilesystem() {
  try {
    return readFileSync("/usr/bin/ldd", "utf-8").includes("musl");
  } catch {
    return null;
  }
}

function isMuslFromReport() {
  let report = null;
  if (typeof process.report?.getReport === "function") {
    process.report.excludeNetwork = true;
    report = process.report.getReport();
  }
  if (!report) {
    return null;
  }
  if (report.header?.glibcVersionRuntime) {
    return false;
  }
  if (Array.isArray(report.sharedObjects) && report.sharedObjects.some(isFileMusl)) {
    return true;
  }
  // Report present but neither signal decisive -> let the filesystem / child-process probes decide.
  return null;
}

function isMuslFromChildProcess() {
  try {
    return require("node:child_process")
      .execSync("ldd --version", { encoding: "utf8" })
      .includes("musl");
  } catch {
    return false;
  }
}

function isMusl() {
  if (process.platform !== "linux") {
    return false;
  }
  let musl = isMuslFromReport();
  if (musl === null) {
    musl = isMuslFromFilesystem();
  }
  if (musl === null) {
    musl = isMuslFromChildProcess();
  }
  return musl;
}

function hostTriple() {
  const { platform, arch } = process;
  if (platform === "win32" && arch === "x64") {
    return "win32-x64-msvc";
  }
  if (platform === "darwin" && arch === "x64") {
    return "darwin-x64";
  }
  if (platform === "darwin" && arch === "arm64") {
    return "darwin-arm64";
  }
  if (platform === "linux" && arch === "x64") {
    return isMusl() ? "linux-x64-musl" : "linux-x64-gnu";
  }
  if (platform === "win32" && arch === "arm64") {
    return "win32-arm64-msvc";
  }
  if (platform === "linux" && arch === "arm64") {
    return isMusl() ? "linux-arm64-musl" : "linux-arm64-gnu";
  }
  return null;
}

function tryRequire(id) {
  try {
    return require(id);
  } catch {
    return null;
  }
}

function isComplete(mod) {
  return (
    mod !== null &&
    typeof mod.cosineSimilarity === "function" &&
    typeof mod.tokenize === "function" &&
    typeof mod.bm25Score === "function"
  );
}

function loadNative() {
  const triple = hostTriple();
  if (triple === null) {
    return null;
  }
  const localBinary = join(__dirname, `obsidian-tc-native.${triple}.node`);
  if (existsSync(localBinary)) {
    const local = tryRequire(localBinary);
    if (isComplete(local)) {
      return local;
    }
  }
  const prebuilt = tryRequire(`@the-40-thieves/obsidian-tc-native-${triple}`);
  return isComplete(prebuilt) ? prebuilt : null;
}

const native = loadNative();
const impl = native !== null ? native : require("./fallback.js");

/** True when the compiled native binary is active; false when on the pure-JS fallback. */
module.exports.nativeLoaded = native !== null;
module.exports.cosineSimilarity = impl.cosineSimilarity;
// cosineBatch: present on a freshly built native module; on an older binary (or the JS fallback)
// impl.cosineBatch resolves from fallback.js. NOT added to isComplete() so an older .node still loads.
module.exports.cosineBatch = impl.cosineBatch;
module.exports.tokenize = impl.tokenize;
module.exports.bm25Score = impl.bm25Score;
// THE-272: symlink-safe, TOCTOU-free vault I/O. Present only when the compiled native module is
// loaded; on the pure-JS fallback these are undefined and the server's vault layer keeps its own
// JS read/write path.
module.exports.safeReadNote = impl.safeReadNote;
module.exports.safeWriteNoteAtomic = impl.safeWriteNoteAtomic;
// Exported for the loader unit test (packages/server/test/native-triple.test.ts).
module.exports.hostTriple = hostTriple;
module.exports.isMusl = isMusl;
