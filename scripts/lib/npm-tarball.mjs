// Download one npm package's tarball from the registry, VERIFY it against the registry's own
// dist.integrity, and unpack it, regardless of the host's os/cpu. Shared by
// scripts/gen-embedded-vec.mjs (one sqlite-vec platform package, for a binary) and
// scripts/bundle-mcpb.ts (all of them, for the universal .mcpb).
//
// `bun install`/`npm install` both skip an optional platform package whose os/cpu does not match
// the host, so cross-target builds cannot read these out of node_modules; a direct registry fetch
// has no such gating.
//
// Fetched over HTTPS rather than by shelling out to `npm pack`, which does not work on Windows at
// all: execFileSync does not go through a shell, so "npm" is ENOENT (there is only npm.cmd), and
// "npm.cmd" is EINVAL because Node refuses to spawn .cmd/.bat without `shell: true`
// (CVE-2024-27980). `shell: true` would fix it by re-joining argv into one command string, which
// is the thing that CVE was about, so the subprocess goes away instead. This broke build-binaries
// (windows-latest) on the v1.14.1 tag, the first run where that job ever reached a verdict. It is
// also strictly better than `npm pack` besides being portable: the registry hands back
// dist.integrity, so the tarball is VERIFIED (`npm pack` was checking nothing here).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Fetch `name@version`, verify its integrity, and unpack it. Resolves to the unpacked package
 * directory (the tarball's `package/` folder); the caller removes `dirname(dir)` when done.
 * Throws if the registry has no such version, the tarball has no URL, or the integrity differs.
 */
export async function fetchVerifiedNpmPackage(name, version, log = () => {}) {
  const spec = `${name}@${version}`;
  const meta = await fetch(`https://registry.npmjs.org/${name}/${version}`).then((r) => {
    if (!r.ok) {
      throw new Error(
        `registry returned ${r.status} for ${spec} — is ${name} published at ${version}?`,
      );
    }
    return r.json();
  });
  const tarballUrl = meta?.dist?.tarball;
  const integrity = meta?.dist?.integrity;
  if (!tarballUrl) throw new Error(`${spec} has no dist.tarball in its registry metadata`);
  const tgz = Buffer.from(await fetch(tarballUrl).then((r) => r.arrayBuffer()));
  if (integrity) {
    // Subresource-integrity form: "<alg>-<base64 digest>". Split on the FIRST hyphen only:
    // JS's split(sep, limit) truncates rather than keeping the remainder, so split("-", 2) would
    // silently drop everything after a second hyphen instead of erroring.
    const dash = integrity.indexOf("-");
    const alg = integrity.slice(0, dash);
    const want = integrity.slice(dash + 1);
    const got = createHash(alg).update(tgz).digest("base64");
    if (got !== want) {
      throw new Error(`${spec} integrity mismatch\n  want ${alg}-${want}\n  got  ${alg}-${got}`);
    }
    log(`${spec} integrity verified (${alg})`);
  } else {
    // Never silently skip: an unverified download is a different security posture, and this is the
    // one place that would know.
    log(`WARNING — ${spec} published no dist.integrity; tarball unverified`);
  }
  const work = mkdtempSync(join(tmpdir(), "obtc-npm-"));
  writeFileSync(join(work, "package.tgz"), tgz);
  // RELATIVE filename plus cwd, never an absolute path. GNU tar — which is what Git-bash supplies
  // on the Windows runners — parses `host:path` as a REMOTE archive, so an absolute Windows path
  // makes it try to resolve the drive letter as a hostname:
  //
  //   tar (child): Cannot connect to C: resolve failed
  //
  // `--force-local` fixes that for GNU tar but is not accepted by the bsdtar in System32, so the
  // portable answer is to hand it no colons at all. tar itself is fine to spawn on all three
  // platforms — it is a real .exe, not a .cmd.
  execFileSync("tar", ["-xzf", "package.tgz"], { cwd: work });
  return join(work, "package");
}
