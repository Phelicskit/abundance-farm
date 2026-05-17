#!/usr/bin/env bash
# ============================================================
# Redeploy + open Abundance Farm in the default browser with a
# cache-busted URL so any stale InvalidKeyMapError is bypassed.
# ============================================================

set -e
cd "$(dirname "$0")"

BOLD=$'\033[1m'; OK=$'\033[32m'; DIM=$'\033[2m'; ERR=$'\033[31m'; RESET=$'\033[0m'

echo "${BOLD}Step 1 of 3: Deploying...${RESET}"
npx --no-install wrangler deploy
echo "${OK}OK${RESET}  deploy complete"

echo
echo "${BOLD}Step 2 of 3: Waiting 4s for edge to propagate...${RESET}"
sleep 4

echo
echo "${BOLD}Step 3 of 3: Probing Google Maps key...${RESET}"
KEY="AIzaSyCicPmLaVbe1W39B0wmi4limBwQPTGdJGM"
URL="https://maps.googleapis.com/maps/api/js?key=$KEY&libraries=drawing,geometry&v=weekly&_r=$(date +%s)"
RESP=$(curl -s "$URL")
if echo "$RESP" | grep -q 'InvalidKeyMapError'; then
  echo "${ERR}✗ Key STILL invalid${RESET} — Google hasn't fully propagated. Wait another 10-30 minutes."
  echo "${DIM}You can re-run this script later; nothing in the worker is broken.${RESET}"
else
  echo "${OK}✓ Key responds with valid loader JS${RESET}"
fi

echo
echo "${BOLD}Opening Abundance Farm with cache buster...${RESET}"
TS=$(date +%s)
open "https://abundance.mak-ct.com/?_nocache=$TS"

echo
echo "${BOLD}${OK}Done!${RESET}  The browser should open Areas → Map automatically."
echo "${DIM}If you still see an empty map, do Cmd+Shift+R to hard-refresh.${RESET}"
echo
echo "${DIM}Press Enter to close.${RESET}"
read -r _ || true
