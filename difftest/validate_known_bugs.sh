#!/usr/bin/env bash
# Validates the comparator on two engine bugs that were found in game and fixed:
#
#   777fcc6  tree canopy_slope read rise/run the wrong way round
#   352de0e  cherry_trunk grew branches.branch_canopy instead of the tree's own canopy
#
# For each fix, the engine side is run twice on the SAME generated pack: once at the commit
# before the fix (standing in for "the engine") and once at the fix (standing in for "the
# game"), with different seeds so the two sides differ in RNG exactly as the real engine and
# game do. The comparator must flag the affected tests as gross and leave the rest alone.
# A third run compares the current engine against itself under different seeds: the
# false-positive baseline.
#
# Usage: bash difftest/validate_known_bugs.sh      (from anywhere inside the checkout)
# Output: difftest/out/validate/<pair>/report.md and a summary on stdout.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
OUT="$ROOT/difftest/out/validate"
GEN="$ROOT/difftest/generated"
mkdir -p "$OUT"

go run ./difftest/cmd/difftest gen --out "$GEN" >/dev/null

# engine_at <commit> <seed-base> <out.json>: run the current difftest code against the engine
# as it was at <commit>, in a throwaway worktree.
engine_at() {
  local commit="$1" seed="$2" out="$3"
  local wt="$OUT/wt-${commit//^/_parent}"
  if [ ! -d "$wt" ]; then
    git worktree add --detach "$wt" "$commit" >/dev/null 2>&1
  fi
  rm -rf "$wt/difftest"
  mkdir -p "$wt/difftest"
  cp -r "$ROOT/difftest/cmd" "$ROOT"/difftest/*.go "$wt/difftest/"
  (cd "$wt" && go run ./difftest/cmd/difftest engine --gen=false --generated "$GEN" \
      --seed-base "$seed" --out "$out" --quiet >/dev/null)
}

compare() {
  local name="$1" engine="$2" game="$3"
  mkdir -p "$OUT/$name"
  go run ./difftest/cmd/difftest compare --generated "$GEN" --engine "$engine" --game "$game" \
    --out-md "$OUT/$name/report.md" --out-json "$OUT/$name/report.json"
}

echo "== canopy_slope: engine before 777fcc6 vs engine at 777fcc6 (as the game)"
engine_at 777fcc6^ 1 "$OUT/slope_before.json"
engine_at 777fcc6 500001 "$OUT/slope_after.json"
compare canopy_slope "$OUT/slope_before.json" "$OUT/slope_after.json"

echo
echo "== cherry: engine before 352de0e vs engine at 352de0e (as the game)"
engine_at 352de0e^ 1 "$OUT/cherry_before.json"
engine_at 352de0e 500001 "$OUT/cherry_after.json"
compare cherry "$OUT/cherry_before.json" "$OUT/cherry_after.json"

echo
echo "== null: current engine vs itself with other seeds (false-positive baseline)"
go run ./difftest/cmd/difftest engine --gen=false --generated "$GEN" --seed-base 1 --out "$OUT/null_a.json" --quiet >/dev/null
go run ./difftest/cmd/difftest engine --gen=false --generated "$GEN" --seed-base 500001 --out "$OUT/null_b.json" --quiet >/dev/null
compare null "$OUT/null_a.json" "$OUT/null_b.json"

for c in 777fcc6 352de0e; do
  for wt in "$OUT"/wt-"$c"*; do
    [ -d "$wt" ] && git worktree remove --force "$wt" >/dev/null 2>&1 || true
  done
done
git worktree prune
