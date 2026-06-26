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

const { existsSync } = require("node:fs");
const { join } = require("node:path");

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
    return "linux-x64-gnu";
  }
  if (platform === "win32" && arch === "arm64") {
    return "win32-arm64-msvc";
  }
  if (platform === "linux" && arch === "arm64") {
    return "linux-arm64-gnu";
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
module.exports.tokenize = impl.tokenize;
module.exports.bm25Score = impl.bm25Score;
