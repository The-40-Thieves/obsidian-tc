// THE-618 items 1-3: FolderAcl compiles its rule globs and per-op whitelists ONCE, at construction.
//
// The memo inside globToRegExp (#574, item 4) removed the RegExp *compile* from the hot path, but
// scopesForPath still paid `rules.length` redundant `String.prototype.normalize("NFC")` calls on the
// SAME path plus a nested Map lookup per rule, and every whitelist check allocated a defensive copy
// of the whitelist before matching it. These tests pin the behaviour that must survive that change —
// last-match-wins order, NFC insensitivity (THE-272), and the M0 undefined-whitelist back-compat —
// and the one behaviour that is deliberately NEW: the config is snapshotted, so a caller mutating the
// object it handed the constructor can no longer rewrite a live ACL.
import { describe, expect, it } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";

function cfg(over: Partial<AclConfigT> = {}): AclConfigT {
  return {
    readOnly: false,
    defaultScopes: ["read:notes"],
    rules: [
      { glob: "**", scopes: ["read:notes"] },
      { glob: "02-projects/**", scopes: ["read:notes", "write:notes"] },
    ],
    readPaths: ["02-projects/**", "00-inbox/*.md"],
    writePaths: ["02-projects/**"],
    deletePaths: [],
    ...over,
  };
}

describe("FolderAcl precompiled rules preserve last-match-wins (THE-618 item 1)", () => {
  it("a later rule overrides an earlier one for the same path", () => {
    const acl = new FolderAcl(cfg());
    expect(acl.scopesForPath("02-projects/a.md")).toEqual(["read:notes", "write:notes"]);
  });

  it("reversing rule order reverses the effective scopes — order is load-bearing, not incidental", () => {
    const reversed = cfg();
    reversed.rules = [...reversed.rules].reverse();
    const acl = new FolderAcl(reversed);
    // "**" now wins for every path, so the narrower write grant is masked.
    expect(acl.scopesForPath("02-projects/a.md")).toEqual(["read:notes"]);
  });

  it("falls back to defaultScopes when no rule matches", () => {
    const acl = new FolderAcl(cfg({ rules: [{ glob: "99-none/**", scopes: ["write:notes"] }] }));
    expect(acl.scopesForPath("02-projects/a.md")).toEqual(["read:notes"]);
  });

  it("still returns a COPY, so a caller cannot escalate later calls", () => {
    const acl = new FolderAcl(cfg());
    acl.scopesForPath("02-projects/a.md").push("delete:notes");
    expect(acl.scopesForPath("02-projects/a.md")).toEqual(["read:notes", "write:notes"]);
  });
});

describe("FolderAcl precompilation keeps NFC normalization load-bearing (THE-272)", () => {
  // "é" as NFD (e + U+0301) on disk vs NFC (U+00E9) in the authored config. Precompiling the glob
  // must normalize it once at construction and STILL normalize the path per call — hoisting the
  // path normalization out of the loop is the win; skipping it is a deny that does not deny.
  const nfc = "02-projects/café/note.md";
  const nfd = "02-projects/café/note.md";

  it("an NFC-authored rule glob matches the NFD form of the same path", () => {
    const acl = new FolderAcl(
      cfg({ rules: [{ glob: "02-projects/café/**", scopes: ["write:notes"] }] }),
    );
    expect(acl.scopesForPath(nfd)).toEqual(["write:notes"]);
  });

  it("an NFD-authored rule glob matches the NFC form of the same path", () => {
    const acl = new FolderAcl(
      cfg({ rules: [{ glob: "02-projects/café/**", scopes: ["write:notes"] }] }),
    );
    expect(acl.scopesForPath(nfc)).toEqual(["write:notes"]);
  });

  it("an NFC-authored whitelist matches the NFD form of the same path", () => {
    const acl = new FolderAcl(cfg({ readPaths: ["02-projects/café/**"] }));
    expect(acl.matchedPathGlob("read", nfd)).toBe("02-projects/café/**");
  });
});

describe("FolderAcl.matchedPathGlob (THE-618 item 3)", () => {
  it("returns the matched glob for an allowed path", () => {
    const acl = new FolderAcl(cfg());
    expect(acl.matchedPathGlob("read", "02-projects/a.md")).toBe("02-projects/**");
  });

  it("returns the FIRST matching glob, matching Array.prototype.find semantics", () => {
    const acl = new FolderAcl(cfg({ readPaths: ["**", "02-projects/**"] }));
    expect(acl.matchedPathGlob("read", "02-projects/a.md")).toBe("**");
  });

  it("returns null when a whitelist exists but nothing matches", () => {
    const acl = new FolderAcl(cfg());
    expect(acl.matchedPathGlob("read", "09-private/secret.md")).toBeNull();
  });

  it("returns undefined when the op has NO whitelist — M0 back-compat is unrestricted", () => {
    const acl = new FolderAcl(cfg({ readPaths: undefined }));
    expect(acl.matchedPathGlob("read", "anything.md")).toBeUndefined();
  });

  it("distinguishes an EMPTY whitelist (deny-all) from an ABSENT one (allow-all)", () => {
    // deletePaths: [] must deny, not fall through to unrestricted. These are different states and
    // collapsing them turns a deny-all into an allow-all.
    const acl = new FolderAcl(cfg());
    expect(acl.matchedPathGlob("delete", "02-projects/a.md")).toBeNull();
    expect(acl.matchedPathGlob("write", "02-projects/a.md")).toBe("02-projects/**");
  });

  it("resolves each op against its OWN whitelist", () => {
    const acl = new FolderAcl(cfg());
    expect(acl.matchedPathGlob("read", "00-inbox/x.md")).toBe("00-inbox/*.md");
    expect(acl.matchedPathGlob("write", "00-inbox/x.md")).toBeNull();
  });
});

describe("FolderAcl snapshots its config at construction (THE-618 constraints 1 + 4)", () => {
  // A FolderAcl is built once per vault and shared across every dispatch. Precompiling the rules
  // freezes them; aclFingerprint — "the only thing that keeps caller A's cached results from
  // reaching caller B" — must be frozen against the SAME source, or a mutated config would move the
  // cache key without moving the ACL it claims to describe. Snapshotting both closes that gap.
  it("mutating the caller's rules array after construction does not change decisions", () => {
    const live = cfg();
    const acl = new FolderAcl(live);
    live.rules.push({ glob: "**", scopes: ["delete:notes"] });
    expect(acl.scopesForPath("02-projects/a.md")).toEqual(["read:notes", "write:notes"]);
  });

  it("mutating the caller's rules array after construction does not move the fingerprint", () => {
    const live = cfg();
    const acl = new FolderAcl(live);
    const before = acl.fingerprint(["read:notes"]);
    live.rules.push({ glob: "**", scopes: ["delete:notes"] });
    expect(acl.fingerprint(["read:notes"])).toBe(before);
  });

  it("mutating the caller's whitelist after construction cannot widen it", () => {
    const live = cfg();
    const acl = new FolderAcl(live);
    live.readPaths?.push("**");
    expect(acl.matchedPathGlob("read", "09-private/secret.md")).toBeNull();
  });

  it("the fingerprint still separates two configs that differ only in rule ORDER", () => {
    const forward = new FolderAcl(cfg());
    const backward = cfg();
    backward.rules = [...backward.rules].reverse();
    expect(new FolderAcl(backward).fingerprint(["read:notes"])).not.toBe(
      forward.fingerprint(["read:notes"]),
    );
  });
});
