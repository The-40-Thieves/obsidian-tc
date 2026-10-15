import { describe, expect, it } from "vitest";
import { challengeProposal, isDecisionChunk, parseChallengeOutput } from "../src/plane/challenge";
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

  it("parseChallengeOutput tolerates code fences and empty categories", () => {
    const fenced = '```json\n{"verdict":"proceed","summary":"ok","categories":[]}\n```';
    expect(parseChallengeOutput(fenced).verdict).toBe("proceed");
  });
});
