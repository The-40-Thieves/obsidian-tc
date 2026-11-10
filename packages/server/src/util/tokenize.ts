/** Lowercase tokenizer over Unicode alphabetic + numbers (matches Rust is_alphanumeric). Mirrors the Rust. */
export function jsTokenize(text: string): string[] {
  const out: string[] = [];
  for (const t of text.split(/[^\p{Alphabetic}\p{N}]+/u)) {
    if (t.length > 0) out.push(t.toLowerCase());
  }
  return out;
}
