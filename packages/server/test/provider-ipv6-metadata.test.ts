// The IPv6 cloud instance-metadata addresses sit inside fc00::/7 (unique-local), which the send
// policy accepts as private. fd00:ec2::254 is AWS's IMDS over IPv6 and fd00:64:64:64::254 is
// Alibaba's: a request there returns instance credentials, so neither may ever receive the bearer
// key or vault text, whether the host is listed or not. The reviewer's repro: a TEI baseUrl
// `http://[fd00:ec2::254]/latest/meta-data/iam/security-credentials/<role>#` with an empty
// network.plainHttpHosts is requested.
import { describe, expect, it, vi } from "vitest";
import {
  createPlainHttpPolicyFetch,
  PlainHttpRefusedError,
  type ResolveHost,
  resolvePlainHttpTarget,
} from "../src/gateway/plain-http";

const METADATA_V6 = ["fd00:ec2::254", "fd00:64:64:64::254", "fd20:ce::254"];

describe("IPv6 metadata addresses are refused by the send policy", () => {
  it.each(METADATA_V6)(
    "%s as an IP literal, unlisted (deprecated unlisted-private path)",
    async (ip) => {
      const url = new URL(`http://[${ip}]/latest/meta-data/iam/security-credentials/role#`);
      await expect(
        resolvePlainHttpTarget(url, { plainHttpHosts: [], allowUnlistedPrivate: true }),
      ).rejects.toBeInstanceOf(PlainHttpRefusedError);
    },
  );

  it.each(METADATA_V6)("%s as an IP literal, listed", async (ip) => {
    const url = new URL(`http://[${ip}]/x`);
    await expect(resolvePlainHttpTarget(url, { plainHttpHosts: [url.hostname] })).rejects.toThrow(
      /not a private address/,
    );
  });

  it.each(METADATA_V6)("a LISTED name that resolves to %s", async (ip) => {
    const resolveHost: ResolveHost = async () => [{ address: ip, family: 6 }];
    await expect(
      resolvePlainHttpTarget(new URL("http://imds.internal/x"), {
        plainHttpHosts: ["imds.internal"],
        resolveHost,
      }),
    ).rejects.toBeInstanceOf(PlainHttpRefusedError);
  });

  it("a name with one ordinary ULA answer and one metadata answer is refused", async () => {
    const resolveHost: ResolveHost = async () => [
      { address: "fd12:3456::1", family: 6 },
      { address: "fd00:ec2::254", family: 6 },
    ];
    await expect(
      resolvePlainHttpTarget(new URL("http://mixed.internal/x"), {
        plainHttpHosts: [],
        allowUnlistedPrivate: true,
        resolveHost,
      }),
    ).rejects.toBeInstanceOf(PlainHttpRefusedError);
  });

  it("an ordinary unique-local address is still sent to (the fix is not a blanket ULA ban)", async () => {
    const target = await resolvePlainHttpTarget(new URL("http://[fd12:3456::1]/x"), {
      plainHttpHosts: [],
      allowUnlistedPrivate: true,
    });
    expect(target.address).toBe("fd12:3456::1");
  });

  it("the policy fetch never opens a socket for the reviewer's TEI repro", async () => {
    const baseFetch = vi.fn<typeof fetch>();
    const f = createPlainHttpPolicyFetch({
      plainHttpHosts: [],
      allowUnlistedPrivate: true,
      baseFetch,
    });
    await expect(
      f("http://[fd00:ec2::254]/latest/meta-data/iam/security-credentials/role/info", {
        method: "GET",
      }),
    ).rejects.toBeInstanceOf(PlainHttpRefusedError);
    expect(baseFetch).not.toHaveBeenCalled();
  });
});
