// Child process for provider-plain-http.test.ts: drives one real provider client through its default
// transport, under Bun, because only Bun's global fetch honours HTTP_PROXY (the parent runs under
// Node, where the proxy variable is inert and a leak would go unseen). argv[2] is a JSON object:
// { driver, cases: [{ baseUrl, plainHttpHosts?, resolveTo? }] }; `resolveTo` stubs the DNS answer
// for every name in that case. Prints one JSON line: { results: [{ ok, message? }] }, one per case.
import {
  configureProviderPlainHttp,
  setProviderResolveHostForTest,
} from "../../src/gateway/provider-fetch";
import { PROVIDER_DRIVERS } from "./provider-drivers";

const spec = JSON.parse(process.argv[2] as string) as {
  driver: string;
  cases: { baseUrl: string; plainHttpHosts?: string[]; resolveTo?: string }[];
};
const driver = PROVIDER_DRIVERS.find((d) => d.name === spec.driver);
const results: { ok: boolean; message?: string }[] = [];
for (const c of spec.cases) {
  configureProviderPlainHttp(c.plainHttpHosts ?? []);
  const address = c.resolveTo;
  setProviderResolveHostForTest(
    address === undefined
      ? undefined
      : async () => [{ address, family: address.includes(":") ? 6 : 4 }],
  );
  try {
    if (!driver) throw new Error(`no driver ${spec.driver}`);
    await driver.call(c.baseUrl);
    results.push({ ok: true });
  } catch (e) {
    const x = e as { message?: string; details?: unknown };
    results.push({ ok: false, message: `${x.message} ${JSON.stringify(x.details ?? "")}` });
  }
}
console.log(JSON.stringify({ results }));
process.exit(0);
