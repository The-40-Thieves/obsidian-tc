export interface Banner {
  version: string;
  vault: string;
  native: string;
  vec: "on" | "off";
}
export interface StageResult {
  stage: string;
  status: "pass" | "fail" | "skip" | "info";
  detail: string;
}
export interface Report {
  path: string;
  platform: string;
  arch: string;
  node: string;
  result: "pass" | "fail";
  firstFailure: string | null;
  stages: StageResult[];
}
export interface ToolResultLike {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}
export interface SemanticClass {
  kind: "semantic" | "error" | "empty" | "wrong-top" | "not-dense";
  detail: string;
  model?: string;
}
export function parseBanner(stderrText: string): Banner | null;
export function nodeSatisfies(version: string, range: string): boolean;
export function expandMcpbVars(
  text: string,
  vars: { dirname: string; userConfig: Record<string, string> },
): string;
export function failureLine(stderrText: string, fallback?: string): string;
export function toolPayload(result: ToolResultLike | undefined): unknown;
export function classifySemantic(
  result: ToolResultLike | undefined,
  expectedTopPath: string,
): SemanticClass;
export function buildReport(input: {
  path: string;
  platform: string;
  arch: string;
  node: string;
  stages: StageResult[];
}): Report;
export function parseExpectedFailures(text: string): Set<string>;
export function renderMatrix(input: {
  paths: string[];
  oses: string[];
  reports: Map<string, Report>;
  expected: Set<string>;
}): string;
