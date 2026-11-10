import { describe, expect, it } from "vitest";
import { resolveSymlinkSupport, SYMLINKS_SUPPORTED } from "./symlink-capability";

const eperm = () => {
  throw Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" });
};

describe("symlink capability probe", () => {
  it("reports a host that can create symlinks", () => {
    expect(resolveSymlinkSupport(() => {}, {})).toBe(true);
  });

  it("skips (false) on a local host without the privilege", () => {
    expect(resolveSymlinkSupport(eperm, {})).toBe(false);
  });

  it("fails loudly under CI instead of skipping", () => {
    expect(() => resolveSymlinkSupport(eperm, { CI: "true" })).toThrow(/cannot create symlinks/);
  });

  it("is a boolean for this host", () => {
    expect(typeof SYMLINKS_SUPPORTED).toBe("boolean");
  });
});
