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
  git commit -m "Big improvements batch: cost preview, batch buy list, price history, AI prompts

After simulating end-to-end corn workflow, shipped 11 quality-of-life additions
covering pricing visibility, automation, and corn-specific polish:

UX polish:
- Print sheet says 'Planted' for corn, 'Sowing' for rice
- Corn areas hide the rice-only Planting Method dropdown
- Area date field auto-labels: 'Planting Date' / 'Seeding Date' / 'Transplant Date'
- Override key parser rejects keys with dashes in the task-id tail (fixes the
  'Plot' vs 'Plot-2' area name prefix collision)

Pricing visibility:
- NPK Tracker now shows live ₱ fertilizer spent per area (applied kg × manual
  prices), plus per-ha cost. Flags missing prices.
- Alt-Fertilizer protocol header shows ₱ savings vs default ('Switching saves
  ₱X this cycle, Y% less'). Uses planSchedCost helper.
- Fertilizer Prices panel adds a Trend column with 12-entry sparkline +
  pct change. Price history auto-snapshots on edit and is server-synced
  (rfops-fertilizerPriceHistory state).

New advisor:
- Dashboard cheapest-N advisor card: surfaces 'Switch <area> to Alt-Fertilizer
  for ₱X savings' when an active area would save ≥₱2000 by switching its urea
  to a cheaper N source based on current prices.

Batch optimization:
- New 'Next 14 days consolidated fertilizer shopping list' panel on the
  Inventory tab. Groups upcoming fertilizer tasks across all active areas,
  subtracts on-hand stock, multiplies short-kg by manual price → 'Need to
  buy: ₱X' single number.

Corn improvements:
- Labor heuristic now distinguishes corn planting (2 wd/ha, drill/hill) from
  rice transplanting (8 wd/ha). Adds 'cultivation' (3 wd/ha) for corn hilling.
- AI diagnose prompt is now crop-aware: corn photos get the full
  fall-armyworm/rust/downy-mildew context; rice photos get
  tungro/blight/blast/leafhopper context. Eliminates rice-tilted answers on
  corn photos.

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
