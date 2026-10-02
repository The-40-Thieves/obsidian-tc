// The LLM judge for ambiguous wiki page matches, split out of observability.schema.ts (biome's
// 700-line cap). Leaf schema like its siblings: imports Zod plus net-host.ts only, and never another
// schema module.
import { z } from "zod";
import { typesafeJudgeIssues } from "../net-host";

// The LLM judge that resolves AMBIGUOUS wiki page matches (find_existing_page, lint_wiki). Embedding
// similarity cannot decide "same topic" (see the calibration in the Wiki checks docs), so a judge
// reads the two texts. It runs through the gateway `judge` role by default, or through TypeSafe Jev
// (`provider: typesafe`, the same opt-in provider block as experiential.citationInfer.judge): no
// judge configured, no judge.
export const WikiJudgeConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        "Whether find_existing_page runs the judge when its `judge` argument is omitted. A call can still pass judge=true or judge=false. Needs a configured judge (a gateway, or provider typesafe); without one the judge never runs. Off by default: the measured recall of topic-to-page judging is too low to turn on. The judge only ever resolves AMBIGUOUS candidates, never overrides exact name, alias or wikidata evidence, never blocks a write, and any failure leaves the verdict ambiguous.",
      ),
    lintEnabled: z
      .boolean()
      .default(true)
      .describe(
        "Whether lint_wiki's near-duplicate pass judges candidate pairs when its `judge` argument is omitted. On by default, but it only runs when a judge is configured and maxCallsPerDay is above 0; the judge only adds a verdict to a proposal, never drops one, never writes and never blocks. A call can still pass judge=true or judge=false. The scheduled sweep has its own switch, maintenance.wikiLint.judge.",
      ),
    provider: z
      .enum(["gateway", "typesafe"])
      .default("gateway")
      .describe(
        'Which service answers. "gateway" (default) uses the gateway `judge` role. "typesafe" (EXPERIMENTAL) asks TypeSafe Jev a Choice question over {same_topic, overlapping, different} instead, using the model, threshold, baseUrl and apiKeyEnv below; it never falls back to the gateway. Jev is a ranking model, not a security control.',
      ),
    model: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Required when provider is "typesafe": a PINNED, versioned TypeSafe model id (e.g. "jev-1.13.0"), rejected at config-load unless it ends in a dotted numeric version. A floating alias such as "jev-latest" would silently move the decision boundary under a fixed threshold.',
      ),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Required when provider is "typesafe": the probability (0..1) Jev must give same_topic for the verdict to be same_topic. It is a ranking score, not a calibrated probability, and has no default: tune it on labelled pairs from your own vault.',
      ),
    apiKeyEnv: z
      .string()
      .min(1)
      .default("TYPESAFE_API_KEY")
      .describe("Environment variable holding the TypeSafe API key (provider typesafe)."),
    baseUrl: z
      .string()
      .url()
      .default("https://api.typesafe.ai")
      .describe(
        "TypeSafe API base URL (provider typesafe). Must be https:// unless the host is loopback or allowPlainHttp is set: this URL carries the bearer key and the opening text of two notes.",
      ),
    allowPlainHttp: z
      .boolean()
      .default(false)
      .describe(
        "Allow ANY http:// baseUrl host, not just loopback. Only for a host-local docker network or an encrypted overlay (e.g. a gateway pass-through at http://litellm:4000/typesafe); the key and note text still travel in clear over whatever link the URL names.",
      ),
    maxCallsPerRequest: z
      .number()
      .int()
      .min(1)
      .max(3)
      .default(3)
      .describe(
        "Most candidates one find_existing_page call sends to the judge (top-ranked first). Cached verdicts do not count.",
      ),
    maxCallsPerDay: z
      .number()
      .int()
      .min(0)
      .max(100000)
      .default(200)
      .describe(
        "Most gateway judge calls per UTC day across every caller (a failed call counts). 0 disables the judge. Cached verdicts do not count. Over the cap, verdicts stay ambiguous.",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(500)
      .max(120000)
      .default(15000)
      .describe(
        "Per-call wait for the judge. On timeout the request to the gateway is cancelled, the candidate stays ambiguous and the tool answers without it. The call still counts against maxCallsPerDay.",
      ),
    maxNoteChars: z
      .number()
      .int()
      .min(200)
      .max(8000)
      .default(2400)
      .describe(
        "Most characters of each page (opening text, after frontmatter) sent to the judge, so one call has a bounded size. A longer page is cut here; the topic string is cut to the same length.",
      ),
  })
  .superRefine((c, ctx) => {
    for (const issue of typesafeJudgeIssues(c, "wikiJudge", "Choice"))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: issue.message });
  })
  .prefault({});
