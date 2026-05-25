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
  git commit -m "Corn-aware fixes: dashboard cards, NPK targets, advisory filters

After the corn protocol shipped, simulated end-to-end use of a corn area and
found several places that still assumed rice schedule shape or detected crop
via breed-substring matching. Fixed:

- Dashboard per-area card: crop-aware key dates (Planted/Tassel/Silk for corn
  vs Sow/Transplant/Panicle for rice) and crop-aware input totals (corn pulls
  from basal_14_14_14_kg + sd1_urea_kg + sd2_urea_kg + sd2_mop_kg; rice pulls
  from the existing N1K1/N2K2/N3K3 fields). All additive expressions now guard
  undefined → 0 so corn cards no longer NaN.

- NPK Tracker: targets now switch on crop. Rice keeps 105N/45P/45K (irrigated
  lowland). Hybrid yellow corn now uses 175N/75P/75K (PhilRice/DA-BPI).

- FieldDiagnose, harvest forecast crop detection, seasonal-hold advisory, and
  skip-AWD weather alert: all now prefer area.crop with breed-substring as
  the legacy fallback.

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
