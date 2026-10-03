// config.path-globs — a configured path glob that matches no file in its vault is a "dead pattern".
// A restriction that is dead fails OPEN and gets the stronger wording; a dead whitelist entry fails
// closed. The scenario that motivated it: a Windows operator's `Private\**`, which used to compile
// to a pattern no vault path could match and say nothing. Config load now normalises the backslash
// (config-path-glob-backslash.test.ts); doctor catches the remaining ways a glob matches nothing
// (a typo, the wrong case, a folder renamed away).
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { deadPathGlobsCheck, pathGlobEntries } from "../src/doctor/dead-path-globs";

const ctx = { serverVersion: "test" };
const FILES = ["Private/a.md", "notes/private/b.md", "notes/pub/c.md", "root.md"];

function run(config: Record<string, unknown>, files: Record<string, string[] | undefined> = {}) {
  const parsed = ServerConfigSchema.parse({
    vaults: [{ id: "main", path: "/tmp/vault" }],
    ...config,
  });
  return deadPathGlobsCheck({
    entries: pathGlobEntries(parsed),
    files: new Map(parsed.vaults.map((v) => [v.id, v.id in files ? files[v.id] : FILES])),
  }).run(ctx);
}

describe("config.path-globs", () => {
  it("is ok on the shipped default (no globs configured)", async () => {
    const r = await run({});
    expect(r.status).toBe("ok");
  });

  it("is ok when every glob matches something, including a backslash-spelled one", async () => {
    const r = await run({
      egress: { excludePaths: ["Private\\**"] },
      acl: {
        readPaths: ["notes\\**", "root.md"],
        rules: [{ glob: "notes\\private\\**", scopes: ["admin:private"] }],
      },
    });
    expect(r.status).toBe("ok");
    expect(r.details?.patterns).toBe("4");
  });

  it("WARNS on a dead RESTRICTION with the fail-open wording", async () => {
    const r = await run({ egress: { excludePaths: ["Privte/**"] } });
    expect(r.status).toBe("warning");
    expect(r.issues?.[0]).toContain('egress.excludePaths "Privte/**"');
    expect(r.issues?.[0]).toContain("fails open");
    expect(r.issues?.[0]).toContain("NOTHING");
  });

  it("WARNS on a dead ACL rule and a dead index exclusion with the fail-open wording", async () => {
    const r = await run({
      acl: { rules: [{ glob: "secret/**", scopes: ["admin:x"] }] },
      vaults: [{ id: "main", path: "/tmp/vault", index: { excludePaths: ["Archive/"] } }],
    });
    expect(r.status).toBe("warning");
    const issues = r.issues ?? [];
    expect(issues).toHaveLength(2);
    for (const i of issues) expect(i).toContain("fails open");
  });

  it("WARNS on a dead WHITELIST entry with the weaker, fail-closed wording", async () => {
    const r = await run({ acl: { readPaths: ["notes/**", "gone/**"] } });
    expect(r.status).toBe("warning");
    expect(r.issues).toHaveLength(1);
    expect(r.issues?.[0]).toContain('acl.readPaths "gone/**"');
    expect(r.issues?.[0]).toContain("grants nothing");
    expect(r.issues?.[0]).not.toContain("fails open");
  });

  it("a /regex/ index exclusion that matches is not dead; one that does not is", async () => {
    const ok = await run({
      vaults: [{ id: "main", path: "/tmp/vault", index: { excludePaths: ["/^notes\\/pub/"] } }],
    });
    expect(ok.status).toBe("ok");
    const dead = await run({
      vaults: [{ id: "main", path: "/tmp/vault", index: { excludePaths: ["/^nope/"] } }],
    });
    expect(dead.status).toBe("warning");
  });

  it("a global glob is judged across every vault it governs: one hit anywhere keeps it alive", async () => {
    const r = await run(
      {
        vaults: [
          { id: "a", path: "/tmp/a" },
          { id: "b", path: "/tmp/b" },
        ],
        egress: { excludePaths: ["Private/**"] },
      },
      { a: ["x.md"], b: ["Private/z.md"] },
    );
    expect(r.status).toBe("ok");
  });

  it("a per-vault acl replaces the global one for that vault only", async () => {
    const vaults = [
      { id: "a", path: "/tmp/a", acl: { readPaths: ["only-a/**"] } },
      { id: "b", path: "/tmp/b" },
    ];
    const ok = await run(
      { vaults, acl: { readPaths: ["only-b/**"] } },
      { a: ["only-a/1.md"], b: ["only-b/2.md"] },
    );
    expect(ok.status).toBe("ok");
    // Each glob is judged against the vault that actually enforces it, so swapping the files
    // makes both dead.
    const swapped = await run(
      { vaults, acl: { readPaths: ["only-b/**"] } },
      { a: ["only-b/2.md"], b: ["only-a/1.md"] },
    );
    expect(swapped.status).toBe("warning");
    expect(swapped.issues).toHaveLength(2);
  });

  it("an empty or unlistable vault is reported as not checked, never as every glob dead", async () => {
    for (const files of [[], undefined]) {
      const r = await run({ egress: { excludePaths: ["Private/**"] } }, { main: files });
      expect(r.status).toBe("ok");
      expect(r.notes?.[0]).toContain("not checked");
    }
  });
});
