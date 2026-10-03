import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const security = readFileSync(
  fileURLToPath(new URL("../../../SECURITY.md", import.meta.url)),
  "utf8",
);
// The release note lives in its fragment until a release folds it into CHANGELOG.md and deletes
// the file, so read whichever holds it.
const fragmentPath = fileURLToPath(
  new URL("../../../changes/release-security-review-hardening.md", import.meta.url),
);
const fragment = existsSync(fragmentPath)
  ? readFileSync(fragmentPath, "utf8")
  : readFileSync(fileURLToPath(new URL("../../../CHANGELOG.md", import.meta.url)), "utf8");

describe("release security hardening claims", () => {
  it("states the exact exclusion, symlink, and rerun-cleanup coverage", () => {
    expect(security).not.toContain("applied live to every search leg");
    expect(security).toContain("M7 retrieval routes");
    expect(security).toContain("persisted under `cacheDir`");
    expect(security).toContain("regular, non-symlink heartbeat marker");
    expect(security).toContain("before and after synchronous staging copies");
    expect(security).toContain("dangling symlinks");

    expect(fragment).toContain("M7 retrieval routes");
    expect(fragment).toContain("persisted last-good Excluded-files rules");
    expect(fragment).toContain("dangling seed symlinks");
    expect(fragment).toContain("non-symlink heartbeat markers");
  });
});
