export interface TrustedExecOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  repoRoot?: string;
  stat?: (path: string) => { mode: number; isFile(): boolean; isDirectory(): boolean } | null;
}
export function resolveExecutable(name: string, options?: TrustedExecOptions): string | null;
export function trustedExecutable(name: string, options?: TrustedExecOptions): string;
