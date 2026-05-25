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
  git commit -m "Fix map blank-screen + GPS integration (4 features)

Map fix:
- Leaflet's container measurement runs during init; when subTab='map' first
  renders the parent's final dimensions haven't settled yet, so the map
  reports 0x0 and shows blank. Now calls invalidateSize() on rAF + at 250ms
  + at 800ms, plus a window resize/orientationchange listener. Also adds an
  errorTileUrl (1x1 transparent gif) so failed satellite tiles don't show
  broken-image boxes; first tile error logged once for debugging.

GPS integration (4 features):
- 'Drop pin at my location' button — in drawing mode, captures current GPS
  as a polygon vertex (far more accurate than tapping on satellite at zoom).
  In idle mode, recenters the map on your position.
- 'Track me' toggle — uses navigator.geolocation.watchPosition to continuously
  update a blue 'you are here' circleMarker + accuracy circle (Leaflet
  circleMarker + circle with radius=accuracy in meters).
- Auto-center on first open — when an area has no polygon yet, request a
  one-shot GPS fix and recenter on the user's position instead of the
  hardcoded Santa Maria coords.
- GPS-tag field diagnose photos — captures lat/lon/accuracy in parallel with
  the /api/diagnose call (best-effort, doesn't block). Stored on the diagnosis
  entry as { gps: { lat, lon, accuracy, at } }. History list shows the
  coordinates as a clickable link to Google Maps with the ±m accuracy badge.

All GPS handlers gracefully degrade if geolocation is unavailable, permission
is denied, or the request times out. Watch handles are cleaned up on unmount.

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
