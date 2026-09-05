// There must be exactly ONE read-ACL predicate in the codebase.
//
// This is not a style rule. The predicate was hand-copied into twelve tool files in five different
// implementations; seven of them silently dropped both isDefaultDenied and strictReadDefault. Advisory
// A1 caught four of those, fixed the four copies, and left the duplication — so the bug survived in the
// other seven for as long as nobody looked. Editing N copies is not a fix; deleting them is.
//
// A grep is the only thing that makes this class of bug non-recurring, so it lives in the test suite
// rather than in a reviewer's memory.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const CANONICAL = "packages/server/src/vault/acl-read-filter.ts";

describe("read-ACL predicate has a single source of truth", () => {
  it("scope floor: a top-level (no subdirectory) src/ file is in the scanned set (THE-954)", () => {
    // `packages/*/src/**/*.ts` alone needs a directory segment between `src/` and the filename, so
    // it silently drops every file directly under a package's src/ — measured on main 7dfd411f at
    // 415 of 437 files, missing packages/server/src/index.ts among 21 others. The plain
    // `packages/*/src/*.ts` pattern below is already fully recursive (git's `*` crosses `/`), so
    // this floor pins a KNOWN top-level file rather than trusting a bare non-zero count, which the
    // lossy pattern would still have produced. packages/server/src/index.ts is the server's own
    // entrypoint — exactly the shape of file the read-ACL predicate this test guards could hide in.
    const files = execFileSync("git", ["ls-files", "packages/*/src/*.ts"], {
      cwd: REPO,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);

    expect(files).toContain("packages/server/src/index.ts");
  });

  it("no file outside acl-read-filter.ts declares its own read-ACL predicate", () => {
    const files = execFileSync("git", ["ls-files", "packages/*/src/*.ts"], {
      cwd: REPO,
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => f && f !== CANONICAL);

    // The shape of the thing: a function taking (acl, rel) and returning a readability boolean.
    const OFFENDER = /^(?:export )?function \w*[Rr]eadable\w*\(\s*acl:[\s\S]{0,80}?\): boolean/m;

    const offenders = files.filter((f) => {
      let body: string;
      try {
        body = readFileSync(`${REPO}/${f}`, "utf8");
      } catch {
        return false;
      }
      return OFFENDER.test(body);
    });

    expect(
      offenders,
      `these files re-declare the read-ACL predicate instead of importing readableRel() from ${CANONICAL}. Editing a copy is not a fix — delete it.`,
    ).toEqual([]);
  });
});
