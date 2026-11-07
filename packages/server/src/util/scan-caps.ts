// Caps for whole-vault scan warning lists, shared by the scanning tools (tools/scan-warnings.ts),
// the conventions checks and dispatch's conventions scope. Kept in util/ so conventions/ and mcp/
// do not import a tool module for a number (no-conventions-imports-high / no-mcp-imports-higher).

/** Warnings kept per result; the rest are only counted (`warnings_omitted`). */
export const MAX_SCAN_WARNINGS = 50;

/** The `warnings` / `warnings_omitted` keys for a list of warnings (absent when there are none). */
export function capWarningsOut<T>(items: readonly T[]): {
  warnings?: T[];
  warnings_omitted?: number;
} {
  return {
    ...(items.length > 0 ? { warnings: items.slice(0, MAX_SCAN_WARNINGS) } : {}),
    ...(items.length > MAX_SCAN_WARNINGS
      ? { warnings_omitted: items.length - MAX_SCAN_WARNINGS }
      : {}),
  };
}
