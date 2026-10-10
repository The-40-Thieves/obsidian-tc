// A one-sentence text account of an attachment, for a client that cannot use the bytes: some
// clients replace an image with a placeholder or drop non-text blocks, and a base64 string in JSON
// tells a model nothing. Name, type, size and (for common raster images) pixel dimensions are all
// the server can say without decoding the picture; text inside it is what ocr_attachment is for.

/** Pixel dimensions from the file header, or undefined when the format is not one of the common
 *  raster ones or the header is truncated/odd. Never throws. */
export function imageDimensions(b: Uint8Array): { width: number; height: number } | undefined {
  const u16be = (o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
  const u32be = (o: number) => ((u16be(o) << 16) | u16be(o + 2)) >>> 0;
  const u16le = (o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
  const u24le = (o: number) => u16le(o) | ((b[o + 2] ?? 0) << 16);
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  const dims = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : undefined;

  // PNG: 8-byte signature, then the IHDR chunk (width, height as big-endian u32).
  if (b.length >= 24 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR")
    return dims(u32be(16), u32be(20));
  // GIF: "GIF8" then little-endian u16 width and height at offset 6.
  if (b.length >= 10 && ascii(0, 4) === "GIF8") return dims(u16le(6), u16le(8));
  // WebP: RIFF....WEBP, then one of three bitstream chunks.
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    if (kind === "VP8X") return dims(u24le(24) + 1, u24le(27) + 1);
    if (kind === "VP8 ") return dims(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    if (kind === "VP8L") {
      const bits = (u16le(21) | (u16le(23) << 16)) >>> 0;
      return dims((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    return undefined;
  }
  // JPEG: walk the marker segments to the first start-of-frame (SOF0..SOF15 bar DHT/JPG/DAC).
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = b[o + 1] ?? 0;
      if (marker === 0xff) {
        o++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return dims(u16be(o + 7), u16be(o + 5));
      o += 2 + u16be(o + 2);
    }
  }
  return undefined;
}

const humanSize = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** "image/png, 1024x768 px, 54.2 KB: screenshot.png. Text in it: ocr_attachment." */
export function describeAttachment(opts: {
  path: string;
  mime: string;
  size: number;
  bytes?: Uint8Array;
}): string {
  const name = opts.path.slice(opts.path.lastIndexOf("/") + 1);
  const dim =
    opts.bytes && opts.mime.startsWith("image/") ? imageDimensions(opts.bytes) : undefined;
  const parts = [
    opts.mime,
    ...(dim ? [`${dim.width}x${dim.height} px`] : []),
    humanSize(opts.size),
  ];
  const ocr =
    opts.mime.startsWith("image/") || opts.mime === "application/pdf"
      ? " Text inside it, if any: ocr_attachment."
      : "";
  return `${parts.join(", ")}: ${name}.${ocr}`;
}
