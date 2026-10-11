// get_index_status.reconcile is set by a background pass that `initialize` starts (deferBootWork), so
// a read taken a couple of round trips after initialize can still be "pending". Whether it is pending
// depends on the runner's speed, not on the code under test, so a caller that asserts the settled
// value has to poll for it, bounded by a deadline.

/**
 * Polls `read` until it stops reporting "pending", or until `timeoutMs` has passed, and returns the
 * last value read (still "pending" when the deadline wins). The clock and the sleep are injectable so
 * the bound can be tested without waiting for it.
 */
export async function settleReconcile(
  read,
  {
    timeoutMs,
    intervalMs = 500,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== "pending" || now() >= deadline) return value;
    await sleep(intervalMs);
  }
}
