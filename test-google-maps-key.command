#!/usr/bin/env bash
# ============================================================
# Probe whether the Google Maps API key has been activated yet.
# Use this when waiting for Google's backend to propagate a new key
# (typically 5min–2hr after first creation on free-trial accounts).
# ============================================================

set -e
cd "$(dirname "$0")"

BOLD=$'\033[1m'; OK=$'\033[32m'; WARN=$'\033[33m'; ERR=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'

KEY="AIzaSyCicPmLaVbe1W39B0wmi4limBwQPTGdJGM"
URL="https://maps.googleapis.com/maps/api/js?key=$KEY&libraries=drawing,geometry&v=weekly"

echo "${BOLD}Probing Google Maps API key...${RESET}"
echo "${DIM}$URL${RESET}"
echo

RESP=$(curl -s "$URL")

if echo "$RESP" | grep -q 'InvalidKeyMapError'; then
  echo "${ERR}✗ STILL INVALID${RESET} — Google hasn't activated the key yet. Wait 30+ more minutes and re-run."
  exit 1
elif echo "$RESP" | grep -q 'ApiNotActivatedMapError'; then
  echo "${ERR}✗ API NOT ACTIVATED${RESET} — Maps JavaScript API isn't enabled for this project."
  exit 1
elif echo "$RESP" | grep -q 'BillingNotEnabledMapError'; then
  echo "${ERR}✗ BILLING NOT ENABLED${RESET} — Add a billing account in Google Cloud Console."
  exit 1
elif echo "$RESP" | grep -q 'google.maps = google.maps'; then
  echo "${OK}✓ KEY IS ACTIVE${RESET} — Google Maps will load successfully now."
  echo
  echo "Open ${BOLD}https://abundance.mak-ct.com${RESET} → Areas → Map sub-tab"
  echo "${DIM}(Cmd+Shift+R for a hard refresh to bypass any cached error.)${RESET}"
else
  echo "${WARN}? UNKNOWN STATE${RESET} — first 500 chars of response:"
  echo "$RESP" | head -c 500
  echo
fi

echo
read -r -p "Press Enter to close..."
