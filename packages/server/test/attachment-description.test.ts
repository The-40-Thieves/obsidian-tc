// get_attachment answers in text for a client that cannot use the bytes (an image placeholder, a
// text-only reader): a `description` sentence always, and include_content=false drops the payload.

import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeAttachment, imageDimensions } from "../src/formats/attachment-description";
import { makeM3Vault } from "./m3-helpers";

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

const png = (w: number, h: number) =>
  Uint8Array.from([
    0x89,
    ...ascii("PNG\r\n\x1a\n"),
    ...u32(13),
    ...ascii("IHDR"),
    ...u32(w),
    ...u32(h),
    8,
    6,
    0,
    0,
    0,
  ]);
const gif = (w: number, h: number) =>
  Uint8Array.from([...ascii("GIF89a"), w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0]);
const jpeg = (w: number, h: number) =>
  Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    4,
    0,
    0,
    0xff,
    0xc0,
    0,
    11,
    8,
    h >> 8,
    h & 255,
    w >> 8,
    w & 255,
    1,
    0,
    0,
    0,
  ]);
const webpX = (w: number, h: number) =>
  Uint8Array.from([
    ...ascii("RIFF"),
    0,
    0,
    0,
    0,
    ...ascii("WEBP"),
    ...ascii("VP8X"),
    10,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    (w - 1) & 255,
    ((w - 1) >> 8) & 255,
    ((w - 1) >> 16) & 255,
    (h - 1) & 255,
    ((h - 1) >> 8) & 255,
    ((h - 1) >> 16) & 255,
  ]);

describe("imageDimensions", () => {
  it("reads PNG, GIF, JPEG and WebP headers", () => {
    expect(imageDimensions(png(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(imageDimensions(gif(320, 200))).toEqual({ width: 320, height: 200 });
    expect(imageDimensions(jpeg(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(webpX(800, 600))).toEqual({ width: 800, height: 600 });
  });

  it("says nothing for text, truncated headers and unknown formats", () => {
    expect(imageDimensions(Uint8Array.from(ascii("png")))).toBeUndefined();
    expect(imageDimensions(png(10, 10).subarray(0, 12))).toBeUndefined();
    expect(imageDimensions(Uint8Array.from(ascii("just some text, not an image at all")))).toBe(
      undefined,
    );
  });
});

describe("describeAttachment", () => {
  it("names type, pixel size, file size and the OCR tool for an image", () => {
    expect(
      describeAttachment({
        path: "assets/shot.png",
        mime: "image/png",
        size: 55_501,
        bytes: png(1024, 768),
      }),
    ).toBe("image/png, 1024x768 px, 54.2 KB: shot.png. Text inside it, if any: ocr_attachment.");
  });

  it("still answers when the format is unknown", () => {
    expect(
      describeAttachment({
        path: "a/b.mp3",
        mime: "audio/mpeg",
        size: 12,
        bytes: new Uint8Array(12),
      }),
    ).toBe("audio/mpeg, 12 B: b.mp3.");
  });
});

describe("get_attachment", () => {
  it("returns a description alongside the base64 payload, and drops the payload on request", async () => {
    const v = makeM3Vault({});
    try {
      const abs = png(64, 32);
      mkdirSync(`${v.root}/assets`, { recursive: true });
      writeFileSync(`${v.root}/assets/pic.png`, abs);

      const full = await v.call("get_attachment", { vault: "test", path: "assets/pic.png" });
      expect(full.ok).toBe(true);
      const data = full.ok ? (full.data as Record<string, unknown>) : {};
      expect(data.description).toBe(
        `image/png, 64x32 px, ${abs.length} B: pic.png. Text inside it, if any: ocr_attachment.`,
      );
      expect(data.content).toBe(Buffer.from(abs).toString("base64"));

      const lean = await v.call("get_attachment", {
        vault: "test",
        path: "assets/pic.png",
        include_content: false,
      });
      const leanData = lean.ok ? (lean.data as Record<string, unknown>) : {};
      expect(leanData.description).toBe(data.description);
      expect("content" in leanData).toBe(false);
    } finally {
      v.cleanup();
    }
  });
});
