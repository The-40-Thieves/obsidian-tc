// Escape C0 controls, DEL and C1 controls in text that came from outside the process before it
// is written to a log. A raw CR/LF forges extra log lines under this script's `name:` prefix
// (and a line starting with `::` reads as a CI workflow command); ESC and C1 bytes reach the
// terminal as control sequences. Printable text, including workflow-command-shaped text that
// stays mid-line, passes through unchanged.
const NAMED = new Map([
  [0x00, "\\0"],
  [0x07, "\\a"],
  [0x08, "\\b"],
  [0x09, "\\t"],
  [0x0a, "\\n"],
  [0x0b, "\\v"],
  [0x0c, "\\f"],
  [0x0d, "\\r"],
  [0x1b, "\\e"],
]);

export function escapeDiagnostic(text) {
  let out = "";
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    out +=
      code < 0x20 || (code >= 0x7f && code <= 0x9f)
        ? (NAMED.get(code) ?? `\\u${code.toString(16).padStart(4, "0")}`)
        : ch;
  }
  return out;
}
