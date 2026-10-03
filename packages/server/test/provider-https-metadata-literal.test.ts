// An https:// provider URL whose host is a cloud instance-metadata ADDRESS (a literal) went to the
// ordinary fetch: the plain-http policy never looked at it, so `https://169.254.169.254/` or
// `https://[fd00:ec2::254]/` was dialed with the bearer key and the vault text in the body. TLS does
// not help: the point is that nothing the operator configured should ever be sent to the metadata
// service. The refusal is by literal address, before any socket exists.
import { describe, expect, it, vi } from "vitest";
import { createPlainHttpPolicyFetch, PlainHttpRefusedError } from "../src/gateway/plain-http";

describe("https to a cloud-metadata literal is refused by the policy fetch", () => {
  it.each([
    "https://169.254.169.254/latest/meta-data/",
    "https://[fd00:ec2::254]/",
    "https://[fd00:ec2:0:0:0:0:0:254]/",
    "https://[FD00:EC2::254]:8443/x",
    "https://100.100.100.200/",
    "https://[fd00:64:64:64::254]/",
    "https://[fd20:ce::254]/",
    "https://[::ffff:169.254.169.254]/",
    "https://[2002:a9fe:a9fe::1]/",
  ])("%s", async (url) => {
    const baseFetch = vi.fn(async () => new Response("{}"));
    const f = createPlainHttpPolicyFetch({
      plainHttpHosts: [],
      baseFetch: baseFetch as unknown as typeof fetch,
    });
    const err = await f(url, {
      method: "POST",
      headers: { authorization: "Bearer sk-secret" },
      body: '{"text":"vault note"}',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlainHttpRefusedError);
    expect((err as Error).message).toMatch(/metadata/i);
    expect((err as Error).message).not.toContain("sk-secret");
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("an ordinary https endpoint, a public literal and a private literal still pass through", async () => {
    const baseFetch = vi.fn(async () => new Response("{}"));
    const f = createPlainHttpPolicyFetch({
      plainHttpHosts: [],
      baseFetch: baseFetch as unknown as typeof fetch,
    });
    for (const url of [
      "https://provider.example/x",
      "https://93.184.216.34/x",
      "https://10.0.0.5/x",
      "https://[2606:4700:4700::1111]/x",
    ]) {
      await f(url, { method: "POST", body: "{}" });
    }
    expect(baseFetch).toHaveBeenCalledTimes(4);
  });
});
