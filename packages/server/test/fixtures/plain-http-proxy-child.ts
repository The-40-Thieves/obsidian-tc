// Child process for plain-http-fetch.test.ts: builds the real TypeSafe judge client and asks one
// question, under Bun, because only Bun's global fetch honours HTTP_PROXY (the parent runs under
// Node, where the proxy variable is inert and a leak would go unseen). argv[2] is a JSON object:
// { baseUrl, plainHttpHosts?, resolveTo? }. `resolveTo` stubs the DNS answer for every name.
// Prints one JSON line: { ok: true, noul } or { ok: false, message }.
import { buildTypesafeJudgeClient } from "../../src/gateway/typesafe-judge-client";

const spec = JSON.parse(process.argv[2] as string) as {
  baseUrl: string;
  plainHttpHosts?: string[];
  resolveTo?: string;
};
const { client } = buildTypesafeJudgeClient(
  {
    model: "jev-1.13.0",
    threshold: 0.5,
    apiKey: "sk-secret-key",
    baseUrl: spec.baseUrl,
    ...(spec.plainHttpHosts !== undefined ? { plainHttpHosts: spec.plainHttpHosts } : {}),
    timeoutMs: 3000,
  },
  { label: "wikiJudge", field: "wikiJudge" },
  undefined,
  spec.resolveTo === undefined
    ? {}
    : {
        resolveHost: async () => [
          { address: spec.resolveTo as string, family: spec.resolveTo?.includes(":") ? 6 : 4 },
        ],
      },
);
try {
  const r = await client.noul({
    state: { a: 1 },
    model: "jev-1.13.0",
    instructions: "q?",
    criteria: { true: "yes", false: "no" },
  });
  console.log(JSON.stringify({ ok: true, noul: r.noul }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, message: (e as Error).message }));
}
process.exit(0);
