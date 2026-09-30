---
type: Added
config-schema-change: retrieval.rrfK, retrieval.densify.knnMinSim
---
- **`retrieval.derivedDefaults`: rrfK derived from each vault's measured index stats (off by default).**
  ADR-0007 class (b) mechanism; no live default changes. One resolver (`search/retrieval-defaults.ts`)
  now owns the RRF constant that used to be a bare `10` in graph search, federated search, multi-query
  fusion, the federated tool, the retrieval-policy record and the gap sweep, plus the kNN edge floor
  constant. Precedence: per-call argument, then an explicit config value, then the derived value (only
  when `retrieval.derivedDefaults` is true), then the shipped constant. Off is byte-identical to before.
  The derivation is `clamp(round(min(seedCount, chunkCount) * 10/30), 2, 60)` from the vault's chunk count
  (per-vault stats cached against the vault generation): every vault with at least 30 chunks derives the
  shipped 10, only a vault smaller than the seed pool differs. It is skipped for a caller restricted by an
  ACL partition, because whole-vault stats steering ranking would leak the vault's size. `knnMinSim` goes
  through the same resolver but is never derived: the index records no neighbour-similarity distribution
  to derive it from. `retrieval.rrfK` and `retrieval.densify.knnMinSim` lose their schema defaults (10 and
  0) so an unset value is distinguishable from an explicit one; the effective values are unchanged.
  `get_server_config` gains `retrieval_defaults` (per vault: the rrfK in effect and which source won, the
  measured stats, and what the derivation would give), `config explain` attributes an unset rrfK, the
  logged retrieval-policy `rrf_k` is the k the fusion actually applied, and `eval/run.ts` gains
  `--derived-defaults`. The multi-shape evidence for making it the default is not in hand; see ADR-0007's
  status section.
