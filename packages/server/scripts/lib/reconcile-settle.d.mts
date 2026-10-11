export interface SettleReconcileOptions {
  timeoutMs: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export function settleReconcile(
  read: () => Promise<string | undefined>,
  opts: SettleReconcileOptions,
): Promise<string | undefined>;
