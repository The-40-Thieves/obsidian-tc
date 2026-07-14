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
  it("no file outside acl-read-filter.ts declares its own read-ACL predicate", () => {
    const files = execFileSync("git", ["ls-files", "packages/*/src/**/*.ts"], {
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
