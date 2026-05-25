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
  git commit -m "Map: auto-fallback to Leaflet when Google Maps key fails

User report (screenshot from mobile): the Map sub-tab shows
'🗝️ Google Maps key needs attention' and renders no map at all when
Google rejects the API key — for example when the HTTP referrer
restriction excludes abundance.mak-ct.com, billing was disabled, or the
Maps JavaScript API was never enabled. The Leaflet variant works fine
without an API key (ESRI satellite tiles) but the app was stuck on the
Google variant, leaving the user with a broken map.

Fix: in GoogleParcelMap, when auth-failure is detected (either via the
global gm_authFailure callback or by spotting Google's own .gm-err-container
error overlay), set window.__gmapsHardFail so we remember across re-mounts,
flip an authFailed state, and from then on render the Leaflet ParcelMap
component instead. The user gets a working satellite map with drawing,
editing, and GPS — and a small yellow banner above explains why we
switched plus a 'How to fix Google Maps' fold-out for when they want to
restore the Google key. Subsequent area switches skip the Google load
attempt entirely (no more 'Loading Google Maps…' flash).

Two earlier issues also bundled in this commit (from end-to-end simulation):

1. Plot C (Ka Danny protocol) showed 0/0 fertilizer totals on the Dashboard
   per-area card. The card had only two branches — corn vs. rice-default —
   so Ka Danny areas hit the rice branch and tried to read urea_N1K1 /
   mop_N1K1 / mop_K from sched.quantities, which Ka Danny doesn't expose
   (it uses amSulf21Bags, amChlBags, bulaklakBags, topDressBags instead).
   Result: every quantity tile rendered 0 kg / 0 bags. Added a third
   branch that detects 'Ka Danny' in sched.protocolName and maps its
   bag-denominated quantities to the 21-0-0 / 25-0-0 / 14-14-14 / 0-0-60
   tiles (plus FAA from totalFAA_L). All branches guard undefined → 0.

2. Demo Plot D's transplantDate + wet-direct planting method placed every
   fertilizer event outside the 14-day batch-buy window, so the new
   'consolidated shopping list' panel rendered empty whenever someone
   loaded the demo. Changed Plot D to plantingMethod='transplanting' and
   transplantDate=today+10 so the seedbed top-dress (21-0-0, 25 kg) and
   basal field events fall in the upcoming window and the panel
   demonstrates correctly.

Verified end-to-end via simulate.mjs harness: 5 area schedules generate
cleanly, dashboard cards now show non-zero totals for all 5 plots,
14-day batch-buy list shows '21-0-0 25 kg (1 bag)' from Plot D, 22
advisories fire (including 2 new altFertSavings rules at high severity),
alt-fert savings computed for 4 plots, labor classifications all correct
for the corn-specific patterns. Total demo dataset: 704 records, 6 years
of revenue ≈ ₱37.4M (realistic for 35 ha rice+corn at 1.04x/yr drift).

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
