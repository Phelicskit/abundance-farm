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
  git commit -m "3 high-impact additions: Excel backup, weather-task risk, supervisor monthly statement

Adds automated test coverage for the NDVI feature shipped in 7e3b951.
While writing the tests one real bug surfaced — the ISO week-year
calculation in reduceToWeeklyPasses was using the original date's
calendar year, which is WRONG for the Dec/Jan boundary: 2024-12-30
(Monday) belongs to ISO week 2025-W01 because the Thursday of that
week falls in 2025. The old code generated key '2024-W01' for that
date, so cross-year passes would never collapse correctly. Fixed by
deriving the week-year from the Thursday's year (tmp.getUTCFullYear()).

Backend tests (test/smoke.mjs) — 12 new checks covering both NDVI
endpoints:
  - auth gate (401 without token)
  - 503 when SENTINEL_HUB_INSTANCE_ID is unset
  - input validation: polygon required + >=3 vertices, fromDate/areaId/
    date required as appropriate
  - KV cache HIT path (pre-populate KV, verify returned image came from
    cache without calling Sentinel Hub)
  - KV cache key includes areaId AND width (different widths = different
    cache key = miss, proves we won't cross-contaminate cached snapshots
    of different sizes for the same area+date)

Frontend tests (stress harness) — 18 new checks covering the pure
helpers extracted from NdviTimeline to module scope so they're
testable without React:
  - reduceToWeeklyPasses: same-week dedup, lowest-cloud wins, null cc
    treated as worst, empty/null inputs handled, invalid date strings
    ignored, cross-year ISO week boundary (the bug found above)
  - deriveNdviMilestones: rice schedule yields 5 milestones, corn
    schedule yields corn-specific labels (no Panicle Init), Ka Danny
    still produces rice-style milestones, null/empty inputs degrade
  - daysFromTransplant: positive, zero, negative, null inputs, invalid
    date strings

Refactor: extracted reduceToWeeklyPasses, deriveNdviMilestones,
daysFromTransplant from NdviTimeline's useMemo bodies to module-scope
functions. The component now calls them inside useMemo so memoization
behavior is unchanged, but the harness can import them directly.

Test totals after this commit:
  - Backend smoke: 41 tests passing (was 29, +12)
  - Frontend stress: 63 tests passing (was 45, +18)
  - FAA units: 8 tests
  - JSX parses cleanly: 842,924 bytes

1. EXCEL ONE-CLICK BACKUP
   New ExcelBackupPanel at the top of the Inventory → Stock Levels tab.
   Loads SheetJS via CDN, builds a multi-sheet .xlsx with one sheet per
   synced-state key (~20 sheets). README sheet at the front lists what's
   where + row counts. Photos/base64 image data are summarised as
   '[image data, N bytes]' so the file stays small. Dated filename.
   Critical for tax/audit/BIR handoff and peace-of-mind insurance.

2. WEATHER → TASK RISK ADVISOR
   New ADVISORY_RULES rule weatherTaskRisk cross-references the 14-day
   Open-Meteo forecast with upcoming weather-sensitive tasks. Surfaces
   'X tasks at risk from weather' Dashboard cards with per-task evidence:
   sprays wash off above 5mm rain or drift above 25kph wind; top-dress
   leaches above 25mm; harvest gets grain loss above 15mm; transplant
   floods above 30mm. Data was already in two unconnected tabs.
   Threaded weather through AdvisorTab → runAdvisoryRules context.

3. SUPERVISOR MONTHLY STATEMENT
   New 'Statement month' picker on Supervisors panel + per-supervisor
   '📄 Statement' button. Opens a print-ready A4 HTML statement in a new
   tab showing: harvests + commissions earned, cash advances drawn, labor
   logged for reference, net due to supervisor, and signature lines.
   Saves the manual computation Kit was doing each month for 7 supervisors.

Refactor: threaded laborLogs + cashAdvances into SupervisorsPanel,
threaded fertilizerPrices + weather into AdvisorTab.

Earlier bundled (from prior commits): 'NDVI' sub-tab on every area shows a weekly grid of Sentinel-2
vegetation snapshots from transplant date to today, with growth-stage
milestones highlighted on the closest pass. Click any thumbnail to
enlarge with full date + days-after-transplant + cloud cover context.

Backend (src/index.js):
- POST /api/ndvi-history — given polygon + date range, returns the list
  of available cloud-free Sentinel-2 passes (dates + cloud cover %) via
  Sentinel Hub WFS catalog. Used by the timeline to know which dates
  have imagery to fetch.
- POST /api/ndvi-snapshot — given polygon + date + width, returns a
  PNG of the NDVI for that area's bounding box at that pass, encoded
  as base64 data-URL. Cached in KV under ndvi-cache:areaId:date:width
  for 60 days so repeat reads cost nothing.
- Auth: signed-in user. Both endpoints 503 if SENTINEL_HUB_INSTANCE_ID
  is unset.

Frontend (NdviTimeline component in public/index.html):
- New 'NDVI' sub-tab on every area, between Map and Protocol
- Header shows area name + date range + stats (cached / fetched / failed
  counters update in real-time as thumbnails load)
- 'Backfill all' button fetches every pass in parallel (4 at a time so
  Sentinel Hub doesn't throttle)
- Weekly grid: one thumbnail per ISO week (pick lowest cloud-cover when
  multiple passes in same week)
- Growth-stage milestones (Sowing/Transplant/Panicle Init/Flowering for
  rice; Planted/Tasseling/Silking for corn) highlighted with green
  border + ★ label on the closest pass within ±3 days
- Each thumbnail shows date, cloud cover (green <10%, amber <30%, red >30%),
  days-after-transplant (DAT), and milestone if any
- Lazy load: first 8 thumbnails fetch automatically; rest fetch on click
- Click thumbnail to enlarge full-screen with full caption
- Friendly empty states: 'Draw the polygon on the Map tab first' if no
  polygon; 'Set a Transplant Date' if no date

Bundled — earlier urgent fix:

The previous Google-Maps-fallback commit (c3445b1) put an early-return
inside GoogleParcelMap that branched on authFailed state — placed BETWEEN
the component's useState declarations (above) and several useEffect calls
(below it). When auth-failure flipped from false to true on mobile,
GoogleParcelMap re-rendered with authFailed=true, took the early-return
path, and called fewer hooks than the previous render. React's Rules of
Hooks enforcement crashed the entire component tree → blank white screen.

This commit moves the fallback decision to the PARENT (AreasManager):
- GoogleParcelMap reverts to its original always-render shape; its only
  new behavior is dispatching a 'gmaps-auth-fail' window event when it
  detects auth failure (in addition to setting window.__gmapsHardFail).
- AreasManager now owns the swap decision via a gmapsFailed useState +
  window-event listener that flips when GoogleParcelMap fires the event.
  When gmapsFailed is true, AreasManager mounts ParcelMap (Leaflet ESRI)
  with a small yellow banner above instead of GoogleParcelMap.
- No hooks are called conditionally in either component — render-order
  is now stable in both render paths.

Same user-visible behavior as the original intent: 'Google Maps unavailable
— using free ESRI satellite tiles instead' banner + working map. But no
more white-screen crash.

Earlier bundled changes still included:

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
