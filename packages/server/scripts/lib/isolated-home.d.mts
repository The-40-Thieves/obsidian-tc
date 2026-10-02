export interface IsolatedHome {
  root: string;
  home: string;
  env: Record<string, string>;
  cleanup: () => void;
}
export function isolatedHomeEnv(home: string): Record<string, string>;
export function isUnder(path: string, root: string): boolean;
export function createIsolatedHome(prefix: string): IsolatedHome;
export function assertStateUnderHome(home: string): void;
