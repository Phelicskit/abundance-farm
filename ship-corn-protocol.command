#!/bin/bash
# Ship the corn protocol + alt-fertilizer + manual override changes.
# Commits everything currently uncommitted in this repo, pushes to main,
# and the existing GitHub Actions workflow auto-deploys to Cloudflare.
#
# Safe to re-run. Cleans up any stale .git/index.lock from a prior aborted run.

set -e
cd "$(dirname "$0")"

echo "=================================================="
echo "  Abundance Farm — ship corn protocol + alt-fert"
echo "=================================================="
echo ""

# --- Auto-recovery: remove stale .git locks if present ---
if [ -f .git/index.lock ]; then
  echo "Found stale .git/index.lock — removing..."
  rm -f .git/index.lock
fi
rm -f .git/objects/*/tmp_obj_* 2>/dev/null || true

# --- Show what's about to ship ---
echo ">> Files changed:"
git status --short
echo ""

# --- Stage + commit + push ---
echo ">> Staging all changes..."
git add -A

if git diff --cached --quiet; then
  echo "Nothing to commit — repo is already clean."
else
  echo ">> Committing..."
  git commit -m "Demo data generator + UI panel (stress test in seconds)

Generates 6 years of simulated farm operations (704 records across 20
categories) so all functions can be exercised end-to-end without manual
data entry. Every demo record is tagged with _demo:true (objects) or has
an id in 800000-899999 (arrays); the Delete button filters by that tag
so real data is never touched.

New code:
- generateDemoData({today, yearsBack}) — pure function that returns a
  deterministic dataset (seeded PRNG, seed=42) covering: 5 areas (4 rice +
  1 corn) with polygons around Santa Maria, 5 supervisors, ~54 harvests
  over 6 years, ~240 timed purchases with inflation drift, 39 labor logs,
  22 cash advances, 3 equipment + 82 fuel logs + 14 maintenance logs,
  41 electricity bills, 25 spray logs, 12 diagnoses with GPS coords,
  fertilizer prices for 6 products with 12-entry history each, 4 recurring
  obligations, 10 custom protocol tasks, 15 task-meta completions,
  8 tool inventory items, 12 usage entries.
- countDemoRecords(state) — counts _demo-tagged items across all the
  shapes used (arrays, dicts of arrays, dicts of objects).
- DemoDataPanel component — collapsed at the bottom of the Inventory tab.
  Shows current count, 'Load' button (merge-only — never overwrites real
  data; skips IDs that already exist), 'Delete' button (filters by _demo).
- Threaded all 18 useSyncedState setters down to InventoryTracker via
  demoStateBag prop so the panel can populate every key in one click.

Co-Authored-By: Claude <noreply@anthropic.com>"
fi

echo ""
echo ">> Pushing to origin/main (this triggers GitHub Actions auto-deploy)..."
git push origin main

echo ""
echo "=================================================="
echo "  ✓ Pushed. Auto-deploy is now running."
echo "=================================================="
echo ""
echo "  Watch the deploy:"
echo "    https://github.com/Phelicskit/abundance-farm/actions"
echo ""
echo "  Once green (~45s), the live site will have the new features:"
echo "    https://abundance.mak-ct.com"
echo ""
echo "  Press any key to close..."
read -n 1 -s
