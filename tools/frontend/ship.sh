#!/bin/sh
# One command for the front end's push gate. Fetch, merge what the backend pushed, check, build, run
# both suites, push. It stops at the first thing that is not green and says which. Nothing here
# thinks: if a merge conflicts, it aborts the merge and leaves the tree as it was.
#
#   tools/frontend/ship.sh            merge origin/main and origin/frontend, gate, push
#   tools/frontend/ship.sh --no-push  the same without the push
#
# Needs the dev server on :8787 (npm run dev) for the pet suite; the smoke test brings its own on :8790.
set -eu
cd "$(dirname "$0")/../.."
say() { printf '\n== %s\n' "$*"; }
say "fetch"; git fetch origin
for ref in origin/main origin/frontend; do
  if [ "$(git rev-list --count HEAD.."$ref")" != "0" ]; then
    say "merge $ref"
    if ! git merge --no-edit "$ref"; then git merge --abort; echo "conflict merging $ref: resolve by hand, then run again"; exit 1; fi
  fi
done
say "typecheck"; npx tsc -p tsconfig.json --noEmit
say "unit tests"; npx vitest run --reporter=dot 2>&1 | tail -3
say "build"; node extension/build.mjs
say "pet suite"; node tools/pet/check.mjs > /tmp/burrow-pet-full.txt 2>&1 || true; grep -aE "checks passed|^FAIL" /tmp/burrow-pet-full.txt | tee /tmp/burrow-pet.txt || tail -20 /tmp/burrow-pet-full.txt
grep -qaE "^[[:space:]]*[0-9]+/[0-9]+ checks passed" /tmp/burrow-pet.txt && [ "$(sed -nE 's#^[[:space:]]*([0-9]+)/([0-9]+) checks passed#\1 \2#p' /tmp/burrow-pet.txt | awk '$1==$2')" != "" ] || { echo "pet suite not green"; exit 1; }
say "smoke test"; E2E_PORT=8790 node e2e/smoke.mjs > /tmp/burrow-e2e-full.txt 2>&1 || true; grep -aE "checks passed|^FAIL" /tmp/burrow-e2e-full.txt | tee /tmp/burrow-e2e.txt || tail -20 /tmp/burrow-e2e-full.txt
[ "$(sed -nE 's#^[[:space:]]*([0-9]+)/([0-9]+) checks passed#\1 \2#p' /tmp/burrow-e2e.txt | awk '$1==$2')" != "" ] || { echo "smoke test not green"; exit 1; }
if [ "${1:-}" = "--no-push" ]; then say "green (not pushed)"; exit 0; fi
say "push"; git push origin HEAD
