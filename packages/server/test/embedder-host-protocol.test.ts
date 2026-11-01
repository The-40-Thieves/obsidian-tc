// GH #1433 rec 4, step 2: the NDJSON protocol between the parent host and the embedder child. One
// JSON object per line, `v: 1`. A line that does not parse, carries another version, or names an
// unknown message is rejected, never half-accepted: the host treats a rejected line as a child crash.
import { describe, expect, it } from "vitest";
import { encodeMessage, type ProtocolMessage, parseMessage } from "../src/embeddings/host/protocol";

const INIT = { model: "m", quantized: true, modelsRoot: "/models", cacheDir: "/cache" };

describe("embedder host NDJSON protocol", () => {
  it("encodes one line per message, with embedded newlines escaped", () => {
    const line = encodeMessage({ t: "embed", v: 1, id: 1, texts: ["a\nb"] });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
  });

  it("round-trips every parent and child message", () => {
    const messages = [
      { t: "init", v: 1, opts: INIT },
      { t: "embed", v: 1, id: 2, texts: ["x", "yy"] },
      { t: "stats", v: 1, id: 3 },
      { t: "shutdown", v: 1 },
      { t: "ready", v: 1, pid: 4242 },
      { t: "result", v: 1, id: 2, vectors: [[0.5, 0.25]] },
      { t: "error", v: 1, id: 2, message: "boom", code: "E" },
      { t: "stats", v: 1, id: 3, rssBytes: 1024 },
    ] satisfies ProtocolMessage[];
    for (const message of messages) {
      expect(parseMessage(encodeMessage(message))).toEqual(message);
    }
  });

  it("rejects a line that is not JSON", () => {
    expect(() => parseMessage("this line is not protocol")).toThrow();
  });

  it("rejects another protocol version", () => {
    expect(() => parseMessage('{"t":"ready","v":2,"pid":1}')).toThrow(/version/);
  });

  it("rejects an unknown message kind", () => {
    expect(() => parseMessage('{"t":"explode","v":1}')).toThrow(/unknown/);
  });

  it("rejects a result without its vectors", () => {
    expect(() => parseMessage('{"t":"result","v":1,"id":1}')).toThrow();
  });
});
