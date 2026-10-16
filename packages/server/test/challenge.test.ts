import { describe, expect, it } from "vitest";
import { challengeProposal, isDecisionChunk, parseChallengeOutput } from "../src/plane/challenge";
import { compileEgressFilter } from "../src/plane/egress-filter";
import type { GatewayRoles } from "../src/plane/gateway";

function judgeReturning(text: string): GatewayRoles {
  return {
    extract: async () => ({ text: "", model: "m" }),
    synthesize: async () => ({ text: "", model: "m" }),
    judge: async () => ({ text, model: "judge-model" }),
  };
}

describe("knowledge_challenge core (gateway judge seam)", () => {
  it("isDecisionChunk classifies by decision-folder path or decision tag", () => {
    expect(isDecisionChunk({ path: "02-projects/x.md" })).toBe(true);
    expect(isDecisionChunk({ path: "10-misc/y.md", tags: ["decision"] })).toBe(true);
    expect(isDecisionChunk({ path: "10-misc/y.md", tags: ["note"] })).toBe(false);
  });

  it("red-teams a proposal via the judge seam and parses the verdict + model", async () => {
    const out =
      '{"verdict":"reconsider","summary":"conflicts with a prior reversal","categories":[{"kind":"REVERSAL","items":[{"evidence_paths":["02-projects/x.md"],"why_it_matters":"undone before","severity":"high"}]}]}';
    const r = await challengeProposal(
      judgeReturning(out),
      "do X",
      [{ path: "02-projects/x.md", content: "we reversed X previously" }],
      [],
    );
    expect(r.output.verdict).toBe("reconsider");
    expect(r.output.categories[0]?.kind).toBe("REVERSAL");
    expect(r.model).toBe("judge-model");
  });

  it("citation check: drops items with no shown path, strips unseen paths, reports them", async () => {
    const out = JSON.stringify({
      verdict: "reconsider",
      summary: "s",
      categories: [
        {
          kind: "REVERSAL",
          items: [
            {
              evidence_paths: ["02-projects/x.md", "private/y.md"],
              why_it_matters: "mixed citation",
              severity: "high",
            },
            { evidence_paths: ["ghost.md"], why_it_matters: "invented", severity: "low" },
          ],
        },
        {
          kind: "PATTERN_REPEAT",
          items: [{ evidence_paths: [], why_it_matters: "uncited", severity: "low" }],
        },
      ],
    });
    const r = await challengeProposal(
      judgeReturning(out),
      "do X",
      [{ path: "02-projects/x.md", content: "we reversed X" }],
      [],
    );
    expect(r.output.categories).toEqual([
      {
        kind: "REVERSAL",
        items: [
          {
            evidence_paths: ["02-projects/x.md"],
            why_it_matters: "mixed citation",
            severity: "high",
          },
        ],
      },
    ]);
    expect(r.citations).toEqual({ unresolved: ["private/y.md", "ghost.md"], droppedItems: 2 });
  });

  it("citation check resolves numbered and dot-relative evidence paths", async () => {
    const out = JSON.stringify({
      verdict: "reconsider",
      summary: "The prior decision applies.",
      categories: [
        {
          kind: "REVERSAL",
          items: [
            { evidence_paths: ["[1]"], why_it_matters: "numbered citation", severity: "high" },
            {
              evidence_paths: ["./02-projects/x.md"],
              why_it_matters: "relative citation",
              severity: "medium",
            },
          ],
        },
      ],
    });
    const r = await challengeProposal(
      judgeReturning(out),
      "do X",
      [{ path: "02-projects/x.md", content: "we reversed X" }],
      [],
    );
    expect(r.output.categories[0]?.items.map((item) => item.evidence_paths)).toEqual([
      ["02-projects/x.md"],
      ["02-projects/x.md"],
    ]);
    expect(r.citations).toEqual({ unresolved: [], droppedItems: 0 });
  });

  it("citation check downgrades a verdict whose only support is removed", async () => {
    const out = JSON.stringify({
      verdict: "do_not_proceed",
      summary: "The uncited claim proves this proposal is unsafe.",
      categories: [
        {
          kind: "DIRECT_CONTRADICTION",
          items: [
            {
              evidence_paths: ["ghost.md"],
              why_it_matters: "unsupported",
              severity: "high",
            },
          ],
        },
      ],
    });
    const r = await challengeProposal(
      judgeReturning(out),
      "do X",
      [{ path: "02-projects/x.md", content: "documented evidence" }],
      [],
    );
    expect(r.output).toEqual({
      verdict: "reconsider",
      summary: "Insufficient supported evidence to retain the original verdict.",
      categories: [],
    });
    expect(r.citations).toEqual({ unresolved: ["ghost.md"], droppedItems: 1 });
  });

  it("citation check replaces a summary that may name partially stripped evidence", async () => {
    const out = JSON.stringify({
      verdict: "reconsider",
      summary: "private/y.md is the decisive evidence.",
      categories: [
        {
          kind: "REVERSAL",
          items: [
            {
              evidence_paths: ["02-projects/x.md", "private/y.md"],
              why_it_matters: "the readable decision still applies",
              severity: "high",
            },
          ],
        },
      ],
    });
    const r = await challengeProposal(
      judgeReturning(out),
      "do X",
      [{ path: "02-projects/x.md", content: "documented evidence" }],
      [],
    );
    expect(r.output.summary).toBe(
      "Some cited evidence was unavailable; retained findings use supported evidence only.",
    );
    expect(r.output.summary).not.toContain("private/y.md");
    expect(r.output.categories).toHaveLength(1);
  });

  it("citation check accepts a readable contradiction path shown to the judge", async () => {
    const out = JSON.stringify({
      verdict: "reconsider",
      summary: "The open contradiction needs resolution.",
      categories: [
        {
          kind: "DIRECT_CONTRADICTION",
          items: [
            {
              evidence_paths: ["notes/opposite.md"],
              why_it_matters: "the opposite side conflicts",
              severity: "high",
            },
          ],
        },
      ],
    });
    const r = await challengeProposal(
      judgeReturning(out),
      "do X",
      [{ path: "02-projects/x.md", content: "documented evidence" }],
      [
        {
          id: "c1",
          source_path: "02-projects/x.md",
          conflict_path: "notes/opposite.md",
          judge_verdict: "contradiction",
          judge_rationale: "the notes disagree",
        },
      ],
    );
    expect(r.output.categories[0]?.items[0]?.evidence_paths).toEqual(["notes/opposite.md"]);
    expect(r.citations).toEqual({ unresolved: [], droppedItems: 0 });
  });

  it("citation check downgrades an objection verdict the judge never cited at all", async () => {
    const out = JSON.stringify({ verdict: "do_not_proceed", summary: "Unsafe.", categories: [] });
    const r = await challengeProposal(
      judgeReturning(out),
      "do X",
      [{ path: "02-projects/x.md", content: "documented evidence" }],
      [],
    );
    expect(r.output).toEqual({
      verdict: "reconsider",
      summary: "Insufficient supported evidence to retain the original verdict.",
      categories: [],
    });
    expect(r.citations).toEqual({ unresolved: [], droppedItems: 0 });
  });

  it("citation check never escalates a proceed verdict when an unsupported item is dropped", async () => {
    const out = JSON.stringify({
      verdict: "proceed",
      summary: "Sound.",
      categories: [
        {
          kind: "HIDDEN_DEPENDENCY",
          items: [{ evidence_paths: ["ghost.md"], why_it_matters: "invented", severity: "low" }],
        },
      ],
    });
    const r = await challengeProposal(
      judgeReturning(out),
      "do X",
      [{ path: "02-projects/x.md", content: "documented evidence" }],
      [],
    );
    expect(r.output).toEqual({ verdict: "proceed", summary: "Sound.", categories: [] });
    expect(r.citations).toEqual({ unresolved: ["ghost.md"], droppedItems: 1 });
  });

  const oneItem = (evidence_paths: string[], extra: { summary?: string; why?: string } = {}) =>
    JSON.stringify({
      verdict: "reconsider",
      summary: extra.summary ?? "Prior work applies.",
      categories: [
        {
          kind: "REVERSAL",
          items: [
            {
              evidence_paths,
              why_it_matters: extra.why ?? "the shown decision applies",
              severity: "high",
            },
          ],
        },
      ],
    });

  it("citation check does not ground an unseen path on a shown note with the same basename", async () => {
    const r = await challengeProposal(
      judgeReturning(
        oneItem(["Private/decision.md"], { summary: "Private/decision.md decides this." }),
      ),
      "do X",
      [{ path: "Public/decision.md", content: "public decision" }],
      [],
    );
    expect(r.output.categories).toEqual([]);
    expect(r.output.verdict).toBe("reconsider");
    expect(r.output.summary).not.toContain("Private/decision.md");
    expect(r.citations).toEqual({ unresolved: ["Private/decision.md"], droppedItems: 1 });
  });

  it("citation check grounds an exact citation of a shown path that itself contains [digits]", async () => {
    for (const path of [
      "02-projects/[2024] Q3 review.md",
      "02-projects/notes [1].md",
      "Book [2].md",
    ]) {
      const r = await challengeProposal(
        judgeReturning(oneItem([path])),
        "do X",
        [
          { path, content: "a bracketed note" },
          { path: "02-projects/x.md", content: "another" },
        ],
        [],
      );
      expect(r.citations, path).toEqual({ unresolved: [], droppedItems: 0 });
      expect(r.output.categories[0]?.items[0]?.evidence_paths, path).toEqual([path]);
    }
  });

  it("citation check never grounds a bare name by basename, even when the basename is unique", async () => {
    const shown = [
      { path: "02-projects/readme.md", content: "a" },
      { path: "09-reference/readme.md", content: "b" },
      { path: "02-projects/unique.md", content: "c" },
    ];
    const ambiguous = await challengeProposal(
      judgeReturning(oneItem(["readme.md"])),
      "do X",
      shown,
      [],
    );
    expect(ambiguous.citations).toEqual({ unresolved: ["readme.md"], droppedItems: 1 });
    const bareUnique = await challengeProposal(
      judgeReturning(oneItem(["[[unique]]"])),
      "do X",
      shown,
      [],
    );
    expect(bareUnique.citations).toEqual({ unresolved: ["[[unique]]"], droppedItems: 1 });
    const exactWithoutExtension = await challengeProposal(
      judgeReturning(oneItem(["[[02-projects/unique]]", "02-projects/unique"])),
      "do X",
      shown,
      [],
    );
    expect(exactWithoutExtension.output.categories[0]?.items[0]?.evidence_paths).toEqual([
      "02-projects/unique.md",
    ]);
    expect(exactWithoutExtension.citations).toEqual({ unresolved: [], droppedItems: 0 });
  });

  it("citation check scrubs the summary and rationale when they name stripped evidence in another spelling", async () => {
    for (const cited of ["./private/y.md", "[[private/y]]", "private/y"]) {
      const r = await challengeProposal(
        judgeReturning(
          oneItem(["02-projects/x.md", cited], {
            summary: "See private/y.md for the decisive point.",
            why: "Also [[private/y]] contradicts the proposal.",
          }),
        ),
        "do X",
        [{ path: "02-projects/x.md", content: "documented evidence" }],
        [],
      );
      expect(r.output.summary, cited).toBe(
        "Some cited evidence was unavailable; retained findings use supported evidence only.",
      );
      expect(r.output.categories[0]?.items[0]?.why_it_matters, cited).toBe(
        "Rationale omitted: it named evidence that was unavailable.",
      );
      expect(r.output.categories[0]?.items[0]?.evidence_paths, cited).toEqual(["02-projects/x.md"]);
    }

    const basenameAlias = await challengeProposal(
      judgeReturning(
        oneItem(["02-projects/x.md", "private/y.md"], {
          summary: "See [[y]] for the decisive point.",
          why: "The y note contradicts the proposal.",
        }),
      ),
      "do X",
      [{ path: "02-projects/x.md", content: "documented evidence" }],
      [],
    );
    expect(basenameAlias.output.summary).toBe(
      "Some cited evidence was unavailable; retained findings use supported evidence only.",
    );
    expect(basenameAlias.output.categories[0]?.items[0]?.why_it_matters).toBe(
      "Rationale omitted: it named evidence that was unavailable.",
    );
  });

  it("citation check neutralizes free text when an unresolved numeric citation cannot be scrubbed reliably", async () => {
    const r = await challengeProposal(
      judgeReturning(
        oneItem(["02-projects/x.md", "[2]"], {
          summary: "A private note contains the decisive point.",
          why: "That unavailable note contradicts the proposal.",
        }),
      ),
      "do X",
      [{ path: "02-projects/x.md", content: "documented evidence" }],
      [],
    );
    expect(r.output.summary).toBe(
      "Some cited evidence was unavailable; retained findings use supported evidence only.",
    );
    expect(r.output.categories[0]?.items[0]?.why_it_matters).toBe(
      "Rationale omitted: it named evidence that was unavailable.",
    );
    expect(r.output.categories[0]?.items[0]?.evidence_paths).toEqual(["02-projects/x.md"]);
  });

  it("egress exclusion that leaves no evidence skips the judge and reports the kept contradictions", async () => {
    let judgeCalls = 0;
    const roles: GatewayRoles = {
      ...judgeReturning(""),
      judge: async () => {
        judgeCalls++;
        return { text: "{}", model: "judge-model" };
      },
    };
    const r = await challengeProposal(
      roles,
      "do X",
      [{ path: "Private/decision.md", content: "secret" }],
      [
        {
          id: "c1",
          source_path: "Private/decision.md",
          conflict_path: "notes/other.md",
          judge_verdict: "contradiction",
          judge_rationale: "r",
        },
      ],
      compileEgressFilter(["Private/**"]),
    );
    expect(judgeCalls).toBe(0);
    expect(r.judged).toBe(false);
    expect(r.keptEvidence).toEqual([]);
    expect(r.keptContradictions).toEqual([]);
    expect(r.excludedCount).toBe(2);
  });

  it("parseChallengeOutput tolerates code fences and empty categories", () => {
    const fenced = '```json\n{"verdict":"proceed","summary":"ok","categories":[]}\n```';
    expect(parseChallengeOutput(fenced).verdict).toBe("proceed");
  });
});
