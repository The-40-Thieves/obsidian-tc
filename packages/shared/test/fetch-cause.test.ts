import { describe, expect, it } from "vitest";
import { extractCauseCode } from "../src/fetch-cause";

describe("extractCauseCode", () => {
  it("reads e.cause.code (Node's fetch shape)", () => {
    const e = Object.assign(new Error("fetch failed"), {
      cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
    });
    expect(extractCauseCode(e)).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
  });

  it("reads e.code directly (Bun's fetch shape)", () => {
    const e = Object.assign(new Error("Unable to connect."), { code: "ConnectionRefused" });
    expect(extractCauseCode(e)).toBe("ConnectionRefused");
  });

  it("takes the first member of an AggregateError cause", () => {
    const e = Object.assign(new Error("fetch failed"), {
      cause: new AggregateError([Object.assign(new Error("a"), { code: "ENOTFOUND" })], "agg"),
    });
    expect(extractCauseCode(e)).toBe("ENOTFOUND");
  });

  it("maps an abort/timeout name to ABORT_ERR", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(extractCauseCode(abort)).toBe("ABORT_ERR");

    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(extractCauseCode(timeout)).toBe("ABORT_ERR");
  });

  it("returns undefined when there is no usable code", () => {
    expect(extractCauseCode(new Error("boom"))).toBeUndefined();
    expect(extractCauseCode("not an error")).toBeUndefined();
  });

  it("rejects a code that is not a bare identifier, e.g. a URL-bearing string", () => {
    const e = Object.assign(new Error("boom"), {
      code: "https://user:topsecret-token@127.0.0.1:27124/some/leaky/path?x=1",
    });
    expect(extractCauseCode(e)).toBeUndefined();
  });
});
