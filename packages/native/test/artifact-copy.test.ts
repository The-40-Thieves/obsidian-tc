// Unit tests for scripts/lib/artifact-copy.mjs (THE-1080, #948). Pure fs-decision logic --
// no cargo, no compiler, no `napi build`. Real temp-dir fs is used for the identical/copy cases;
// the lock-error case injects a fake fsImpl since a real EBUSY/EPERM is not reliably reproducible
// in a test sandbox.

import * as realFs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactCopyError, copyArtifactIfChanged } from "../scripts/lib/artifact-copy.mjs";

describe("copyArtifactIfChanged", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "artifact-copy-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips the write when destination already has identical bytes", () => {
    const srcPath = join(dir, "src.node");
    const destPath = join(dir, "dest.node");
    writeFileSync(srcPath, "same-bytes");
    writeFileSync(destPath, "same-bytes");

    const result = copyArtifactIfChanged({ srcPath, destPath, platform: "linux", fsImpl: realFs });

    expect(result).toEqual({ action: "skipped", destPath });
    expect(readFileSync(destPath, "utf8")).toBe("same-bytes");
  });

  it("copies and renames into place when destination differs", () => {
    const srcPath = join(dir, "src.node");
    const destPath = join(dir, "dest.node");
    writeFileSync(srcPath, "new-bytes");
    writeFileSync(destPath, "old-bytes");

    const result = copyArtifactIfChanged({ srcPath, destPath, platform: "linux", fsImpl: realFs });

    expect(result).toEqual({ action: "copied", destPath });
    expect(readFileSync(destPath, "utf8")).toBe("new-bytes");
  });

  it("copies when the destination does not exist yet", () => {
    const srcPath = join(dir, "src.node");
    const destPath = join(dir, "dest.node");
    writeFileSync(srcPath, "fresh-bytes");

    const result = copyArtifactIfChanged({ srcPath, destPath, platform: "linux", fsImpl: realFs });

    expect(result).toEqual({ action: "copied", destPath });
    expect(readFileSync(destPath, "utf8")).toBe("fresh-bytes");
  });

  it("throws a typed error naming the errno and destination path on a lock", () => {
    const srcPath = join(dir, "src.node");
    const destPath = join(dir, "dest.node");
    writeFileSync(srcPath, "new-bytes");
    writeFileSync(destPath, "old-bytes");

    const lockErr = Object.assign(new Error("busy"), { code: "EBUSY" });
    const fsImpl = {
      existsSync: realFs.existsSync,
      readFileSync: realFs.readFileSync,
      copyFileSync: realFs.copyFileSync,
      unlinkSync: realFs.unlinkSync,
      renameSync: () => {
        throw lockErr;
      },
    };

    let caught: unknown;
    try {
      copyArtifactIfChanged({ srcPath, destPath, platform: "linux", fsImpl });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ArtifactCopyError);
    const err = caught as InstanceType<typeof ArtifactCopyError>;
    expect(err.code).toBe("EBUSY");
    expect(err.destPath).toBe(destPath);
    expect(err.message).toContain("EBUSY");
    expect(err.message).toContain(destPath);
    expect(err.message).not.toContain("dist/cli.js");
  });

  it("adds the MCP-client hint only when platform is win32", () => {
    const srcPath = join(dir, "src.node");
    const destPath = join(dir, "dest.node");
    writeFileSync(srcPath, "new-bytes");
    writeFileSync(destPath, "old-bytes");

    const lockErr = Object.assign(new Error("perm"), { code: "EPERM" });
    const fsImpl = {
      existsSync: realFs.existsSync,
      readFileSync: realFs.readFileSync,
      copyFileSync: realFs.copyFileSync,
      unlinkSync: realFs.unlinkSync,
      renameSync: () => {
        throw lockErr;
      },
    };

    let caught: unknown;
    try {
      copyArtifactIfChanged({ srcPath, destPath, platform: "win32", fsImpl });
    } catch (err) {
      caught = err;
    }

    expect((caught as Error).message).toContain("dist/cli.js");
    expect((caught as Error).message).toContain("stop it and re-run");
  });

  it("propagates a non-lock error unchanged", () => {
    const srcPath = join(dir, "src.node");
    const destPath = join(dir, "dest.node");
    writeFileSync(srcPath, "new-bytes");
    writeFileSync(destPath, "old-bytes");

    const oddErr = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const fsImpl = {
      existsSync: realFs.existsSync,
      readFileSync: realFs.readFileSync,
      copyFileSync: realFs.copyFileSync,
      unlinkSync: realFs.unlinkSync,
      renameSync: () => {
        throw oddErr;
      },
    };

    expect(() => copyArtifactIfChanged({ srcPath, destPath, platform: "linux", fsImpl })).toThrow(
      "disk full",
    );
  });
});
