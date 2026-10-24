// audit_provenance (GH #1334, first slice): a note with no `sources` field but evidence in its body
// (a URL, a footnote definition, a Sources/References section with a list or link) is reported as
// "cited in body only", not missing. `types` limits the claim-bearing set by frontmatter `type`.
// The scan reads only notes the caller's read ACL admits, so a denied body is never counted.
import { describe, expect, it } from "vitest";
import { makeTestVault } from "./m1-helpers";
import { makeWikiHarness } from "./wiki-test-helpers";

const NL = String.fromCharCode(10);
const fm = (...lines: string[]): string => ["---", ...lines, "---"].join(NL);

interface BodyOnly {
  path: string;
  evidence: string[];
}

interface Audit {
  scanned: number;
  with_provenance: number;
  missing: string[];
  missing_provenance: number;
  body_only: BodyOnly[];
  body_only_count: number;
  skipped_by_type: number;
}

async function audit(files: Record<string, string>, input: Record<string, unknown> = {}) {
  const v = makeTestVault({ files });
  try {
    const r = await v.call("audit_provenance", { vault: "test", ...input });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("audit_provenance failed");
    return r.data as unknown as Audit;
  } finally {
    v.cleanup();
  }
}

describe("audit_provenance: body citations", () => {
  it("a note whose body cites a URL is cited in body only, not missing", async () => {
    const d = await audit({
      "url-note.md": fm("type: research") + NL + "Claim, see https://example.com/paper for it.",
      "bare.md": fm("type: research") + NL + "Claim with no evidence at all.",
    });
    expect(d.body_only).toEqual([{ path: "url-note.md", evidence: ["url"] }]);
    expect(d.body_only_count).toBe(1);
    expect(d.missing).toEqual(["bare.md"]);
    expect(d.missing_provenance).toBe(1);
  });

  it("a footnote definition counts as a footnote citation", async () => {
    const d = await audit({
      "fn.md": "A claim.[^1]" + NL + NL + "[^1]: Smith 2024, a journal article.",
    });
    expect(d.body_only).toEqual([{ path: "fn.md", evidence: ["footnote"] }]);
    expect(d.missing).toEqual([]);
  });

  it("a Sources section with a list item counts; a Sources section of plain prose does not", async () => {
    const d = await audit({
      "listed.md": "Claim." + NL + NL + "## Sources" + NL + NL + "- Smith 2024" + NL,
      "prose.md": "Claim." + NL + NL + "## References" + NL + NL + "See the literature.",
    });
    expect(d.body_only).toEqual([{ path: "listed.md", evidence: ["sources_section"] }]);
    expect(d.missing).toEqual(["prose.md"]);
  });

  it("a Sources heading matches at any level, case-insensitively, and a link under it counts", async () => {
    const d = await audit({
      "deep.md": "Claim." + NL + NL + "#### sOuRcEs" + NL + NL + "[[some-note]]" + NL,
    });
    expect(d.body_only).toEqual([{ path: "deep.md", evidence: ["sources_section"] }]);
  });

  it("a URL inside a fenced code block does not count", async () => {
    const d = await audit({
      "code.md": [
        "Claim with a sample.",
        "",
        "```bash",
        "curl https://example.com/api",
        "```",
      ].join(NL),
    });
    expect(d.body_only).toEqual([]);
    expect(d.missing).toEqual(["code.md"]);
  });

  it("a URL inside an inline code span does not count", async () => {
    const d = await audit({ "span.md": "Claim, the endpoint is `https://example.com/api`." });
    expect(d.body_only).toEqual([]);
    expect(d.missing).toEqual(["span.md"]);
  });

  it("frontmatter sources still wins over body evidence", async () => {
    const d = await audit({
      "both.md": fm("sources:", "  - '[[ref]]'") + NL + "Claim, see https://example.com.",
    });
    expect(d.with_provenance).toBe(1);
    expect(d.body_only).toEqual([]);
    expect(d.missing).toEqual([]);
  });

  it("a `source:` key is not a sources field, and a body citation still counts", async () => {
    const d = await audit({
      "alias.md": fm("source: https://example.com") + NL + "Claim.",
    });
    expect(d.with_provenance).toBe(0);
    expect(d.body_only).toEqual([]);
    expect(d.missing).toEqual(["alias.md"]);
  });

  it("evidence kinds are reported together when a note has more than one", async () => {
    const d = await audit({
      "many.md": "See https://example.com[^a]" + NL + NL + "[^a]: note",
    });
    expect(d.body_only).toEqual([{ path: "many.md", evidence: ["url", "footnote"] }]);
  });

  it("the read ACL keeps denied notes out of the scan entirely", async () => {
    const v = makeTestVault({
      files: {
        "public/open.md": "Claim, see https://example.com.",
        "secret/hidden.md": "Claim, see https://example.com.",
        "secret/bare.md": "No evidence.",
      },
      acl: { readPaths: ["public/**"] },
    });
    try {
      const r = await v.call("audit_provenance", { vault: "test" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.data as unknown as Audit;
      expect(d.scanned).toBe(1);
      expect(d.body_only).toEqual([{ path: "public/open.md", evidence: ["url"] }]);
      expect(d.missing).toEqual([]);
    } finally {
      v.cleanup();
    }
  });
});

describe("audit_provenance: types filter", () => {
  const files = {
    "r1.md": fm("type: research") + NL + "Claim.",
    "r2.md": fm("type: [reference, draft]") + NL + "Claim, see https://example.com.",
    "log.md": fm("type: log") + NL + "Did a thing.",
    "untyped.md": "No frontmatter at all.",
  };

  it("without types every readable note is claim-bearing (unchanged)", async () => {
    const d = await audit(files);
    expect(d.scanned).toBe(4);
    expect(d.skipped_by_type).toBe(0);
  });

  it("with types only matching notes are claim-bearing; the rest are counted as skipped", async () => {
    const d = await audit(files, { types: ["research", "reference"] });
    expect(d.scanned).toBe(2);
    expect(d.skipped_by_type).toBe(2);
    expect(d.missing).toEqual(["r1.md"]);
    expect(d.body_only).toEqual([{ path: "r2.md", evidence: ["url"] }]);
  });

  it("an array-valued type matches when it contains one of the given types", async () => {
    const d = await audit(files, { types: ["draft"] });
    expect(d.scanned).toBe(1);
    expect(d.body_only.map((b) => b.path)).toEqual(["r2.md"]);
  });
});

describe("lint_wiki missing_sources inherits the body citations", () => {
  it("a body-cited note is not proposed as missing sources", async () => {
    const h = makeWikiHarness({
      files: {
        "cited.md": "Claim, see https://example.com.",
        "bare.md": "No evidence.",
      },
    });
    try {
      const r = await h.call("lint_wiki", { vault: "test", checks: ["missing_sources"] });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const subjects = (
        r.data as unknown as { proposals: Array<{ subject: string }> }
      ).proposals.map((p) => p.subject);
      expect(subjects).toEqual(["bare.md"]);
    } finally {
      h.v.cleanup();
    }
  });
});
