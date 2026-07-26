#!/usr/bin/env bash
# THE-532: kNN derived-edge sweep, k x floor x derivedWeight.
# Grid and analysis plan are FROZEN in docs/plans/2026-07-26-knn-sweep-preregistration.md.
#
# knnK/knnMinSim are INDEX-time, so each (k,floor) pair costs a full densify rebuild (~15 min on
# the 12,159-chunk eval index — dominated by indexVault's vault walk, not the KNN itself).
# derivedWeight is SEARCH-time, so its values are swept against one rebuilt index. That ordering is
# the whole reason the loop is nested this way: reversing it would pay the rebuild 8 times instead
# of 4.
set -euo pipefail

CONFIG="${CONFIG:-$HOME/obsidian-tc-eval/eval-config.nomic-ctx.json}"
GOLDEN="${GOLDEN:-$HOME/obsidian-tc-eval/multi-hop-golden-set.yaml}"
OUT="${OUT:-$HOME/obsidian-tc-eval/the532-sweep}"
mkdir -p "$OUT"

# Assert the corpus before spending hours on it. A short or stale corpus must FAIL, not quietly
# produce numbers attributed to n=250.
python3 -c "
import yaml,sys
q = yaml.safe_load(open('$GOLDEN'))['queries']
assert len(q) == 250, f'expected 250 queries, got {len(q)} — wrong or stale corpus'
print(f'corpus OK: {len(q)} queries from $GOLDEN')
"

cd "$(dirname "$0")/.."

# THE-532: the INDEX must be settled before the control arm, and it must not move afterwards.
#
# This is not hypothetical. The first attempt at this sweep collected a control against a
# 12,159-chunk index; the next densify ran indexVault, which found 142 notes added to the vault
# since the index was built and re-embedded them. Every cell would then have been measured against
# a 12,301-chunk corpus while the control sat at 12,159 — a corpus difference masquerading as a
# densification effect, and nothing in the output would have shown it.
#
# So: run one reconcile FIRST to absorb any vault drift, assert every chunk carries an active
# embedding, and record the count next to the results. A later reader can then check that the
# control and the cells describe the same corpus instead of trusting that they do.
CACHE_DB="$(python3 -c "import json,os;print(os.path.join(json.load(open('$CONFIG'))['cacheDir'],'cache.db'))")"
echo "=== SETTLE INDEX (absorb vault drift before the control arm) ==="
bun eval/densify-index.ts "$CONFIG" --settle || true
python3 -c "
import sqlite3, json, sys
c = sqlite3.connect('$CACHE_DB')
chunks = c.execute('select count(*) from chunks').fetchone()[0]
active = c.execute('select count(*) from chunk_embeddings where is_active=1').fetchone()[0]
if chunks != active:
    sys.exit(f'index NOT settled: {chunks} chunks vs {active} active embeddings — a cell measured now '
             'would differ from the control by CORPUS, not by densification')
json.dump({'chunks': chunks, 'active_embeddings': active, 'corpus': '$GOLDEN'},
          open('$OUT/index-state.json','w'), indent=2)
print(f'index settled: {chunks} chunks, all embedded')
"

# Control: same index, derived edges NOT walked. Run once — it does not depend on the edge set.
if [ ! -f "$OUT/control.json" ]; then
  echo "=== CONTROL (derived edges not walked) ==="
  bun eval/run.ts "$CONFIG" "$GOLDEN" --json "$OUT/control.json" || true
fi

for K in 8 24; do
  for FLOOR in 0.0 0.60; do
    echo "=== DENSIFY k=$K floor=$FLOOR ==="
    bun eval/densify-index.ts "$CONFIG" --k "$K" --floor "$FLOOR" \
      | tee "$OUT/densify-k${K}-f${FLOOR}.json"
    for W in 0.5 1.0; do
      CELL="k${K}-f${FLOOR}-w${W}"
      if [ -f "$OUT/$CELL.json" ]; then echo "skip $CELL (exists)"; continue; fi
      echo "=== CELL $CELL ==="
      DENSIFY=1 DERIVED_WEIGHT="$W" bun eval/run.ts "$CONFIG" "$GOLDEN" \
        --json "$OUT/$CELL.json" || true
    done
  done
done

echo "=== SWEEP COMPLETE -> $OUT ==="
ls -1 "$OUT"
