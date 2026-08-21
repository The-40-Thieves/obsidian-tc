// experiential.capture-location (THE-891 item 3) — does cacheDir resolve inside any configured
// vault root? Mirrors doctor-note-summary-scale.test.ts's shape, minus the --probe axis: this
// check reads only two already-resolved config values, so there is no offline/online split.
import { describe, expect, it } from "vitest";
import { type CaptureLocationView, captureLocationCheck } from "../src/doctor/capture-location";

const ctx = { serverVersion: "test" };
const run = (view: CaptureLocationView) => captureLocationCheck(view).run(ctx);

describe("experiential.capture-location", () => {
  it("is ok when cacheDir sits outside every vault root — the shipped default", async () => {
    // config/load.ts anchors the default (".obsidian-tc") to homedir(), which never nests inside
    // a vault path.
    const r = await run({
      cacheDir: "/home/user/.obsidian-tc",
      vaults: [{ id: "main", path: "/home/user/Documents/vault" }],
    });
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("outside every configured vault root");
  });

  it("WARNS when cacheDir is nested inside a vault root, and names the vault", async () => {
    const r = await run({
      cacheDir: "/home/user/iCloud/vault/.obsidian-tc",
      vaults: [{ id: "icloud-vault", path: "/home/user/iCloud/vault" }],
    });
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toContain("icloud-vault");
    expect(r.remediation).toBeTruthy();
  });

  it("WARNS when cacheDir equals the vault root exactly", async () => {
    const r = await run({
      cacheDir: "/home/user/vault",
      vaults: [{ id: "main", path: "/home/user/vault" }],
    });
    expect(r.status).toBe("warning");
  });

  it("checks EVERY configured vault, not just the first", async () => {
    const r = await run({
      cacheDir: "/home/user/sync/vault-b/.obsidian-tc",
      vaults: [
        { id: "vault-a", path: "/home/user/local/vault-a" },
        { id: "vault-b", path: "/home/user/sync/vault-b" },
      ],
    });
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toContain("vault-b");
    expect(r.issues?.join(" ")).not.toContain("vault-a");
  });

  it("does not false-positive on a sibling path that merely shares a string prefix", async () => {
    // /home/user/vault-two must not be treated as nested inside /home/user/vault.
    const r = await run({
      cacheDir: "/home/user/vault-two/.obsidian-tc",
      vaults: [{ id: "main", path: "/home/user/vault" }],
    });
    expect(r.status).toBe("ok");
  });

  it("is ok with an empty vault list — nothing to be nested inside", async () => {
    const r = await run({ cacheDir: "/home/user/.obsidian-tc", vaults: [] });
    expect(r.status).toBe("ok");
  });

  it("never returns fail — a misplaced cacheDir breaks no request outright", async () => {
    const r = await run({
      cacheDir: "/home/user/vault",
      vaults: [{ id: "main", path: "/home/user/vault" }],
    });
    expect(r.status).not.toBe("fail");
  });
});
