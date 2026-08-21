# `vault_context`: prewarm cache, differential mode, write-through

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries the history and evidence.

## Prewarm-cache hit: four independent layers, any one a miss (THE-543, THE-417, THE-136)

`vault_context`'s session-bootstrap mode (no `query`) can serve a bundle the anticipatory prefetch
already composed, instead of a live compose. Serving from cache is safe only because four
independent layers must all agree before a cached entry is returned; any one disagreeing is a full
miss — never a partial return.

1. **TTL + signal hash** (`readPrewarm`). The reader enforces the cache TTL, and an edited
   `_next-session.md` invalidates immediately via a content hash — no separate invalidation signal
   is needed. An empty marker (the prefetch floor, written when a prefetch composed nothing) falls
   through to a live compose rather than being served. Cache hits are not retrieval-logged: no live
   retrieval happened, and the prefetch run that produced the cached bundle already logged its own.

2. **Cache key: caller + content** (THE-543). The key binds the CALLER (`acl_fingerprint`) and the
   CONTENT (`vault_generation`) that produced the bundle. An entry written under a broader ACL, or
   one whose vault has since mutated, is a miss here, not a match — this is the same
   `callerAclFingerprint` used elsewhere to key retrieval caches by effective ACL.

3. **Per-path ACL recheck** (THE-543 layer 3). Every path the cached bundle references is
   re-checked against THIS dispatch's ACL, regardless of the key match in layer 2. A bundle is a
   composed whole: if any path in it is now unreadable, the whole entry is a miss, never a partial
   return.

4. **Shape validation** (THE-417 layer 4). `PrewarmEntry.bundle` is `Record<string, unknown>` read
   from disk, so nothing guarantees a cached entry matches the tool's current response shape — a
   bundle written by an older build with a different shape would previously have been served
   verbatim. The bundle is now validated against `VaultContextOutput` and a mismatch is treated as a
   MISS, the same discipline as layers 2 and 3: a bundle is a composed whole, so a partial or
   stale-shaped one falls through to a live compose rather than being returned in part.

## Write-through: a live bootstrap compose refreshes the cache (THE-136)

When a live compose happens in bootstrap mode (cache miss, or no `prewarmDir`), the composed
response is written back to the prewarm cache (atomic tmp+rename, so no reader ever catches a torn
file). This makes the *next* bootstrap call within the TTL a hit even without a scheduled prefetch
run having run first. The written entry records the fingerprint of the ACL that actually produced
the response (`results` were already filtered through `readableRel(ctx.acl, ...)` before this point)
and the vault generation at write time, so a later reader under a different or wider ACL, or after
content moved, misses instead of inheriting this caller's view. Best-effort: a write failure leaves
the response (already fully composed) unaffected.

## Differential mode: `since` is a floor hint, not the filter of record (THE-647)

`since` (ISO-8601) switches `vault_context` from top-K-by-relevance packing to "what's new since a
cutoff" for notes, syntheses, contradictions, and (with `include_work`) episodes. The client-supplied
value is a **lower-bound hint**, not authoritative: the server floors it against this caller's own
server-stored watermark (`readContextWatermark`), when one exists, before filtering. This means a
client clock running ahead of the server, or a replay of a stale cached `since`, can only ever cause
a row to be seen *again* — never cause a row to be silently skipped. The response's `diff_since`
always echoes the cutoff that was actually applied, plus the safe next value to pass on the
following call.

Ordering is load-bearing: the watermark to persist (`capturedWatermarkMs`) is captured *before* any
of the diff reads run, not re-derived afterward. A value captured after the reads would let a row
written concurrently, between the capture and the read, be marked "already seen" by the persisted
watermark without ever having been returned to any caller — over-delivery is an acceptable failure
mode here, silent loss is not. The watermark is persisted only after the full response is composed,
and persistence is best-effort: a failure degrades a future diff call to a wider (never narrower)
window rather than producing a broken response.
