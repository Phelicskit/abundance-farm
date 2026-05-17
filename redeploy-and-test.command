#!/usr/bin/env bash
# ============================================================
# Redeploy + auto-test the Sentinel-2 imagery endpoint.
# Use this when iterating on the worker — verifies the deploy
# actually fixed the issue rather than just shipping blindly.
# ============================================================

set -e
cd "$(dirname "$0")"

BOLD=$'\033[1m'; OK=$'\033[32m'; WARN=$'\033[33m'; ERR=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'

echo "${BOLD}Redeploying...${RESET}"
npx --no-install wrangler deploy

echo
echo "${BOLD}Waiting 5s for edge to propagate...${RESET}"
sleep 5

echo
echo "${BOLD}Testing /api/ndvi-info (Santa Maria, Isabela)...${RESET}"
RESP=$(curl -s "https://abundance.mak-ct.com/api/ndvi-info?lat=16.8167&lon=121.7167&days=90&maxcc=60")
echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"

# Parse out the date field to give a one-line verdict
DATE=$(echo "$RESP" | sed -nE 's/.*"date": *"([^"]+)".*/\1/p')
TYPE=$(echo "$RESP" | sed -nE 's/.*"usedType": *"([^"]+)".*/\1/p')
COUNT=$(echo "$RESP" | sed -nE 's/.*"count": *([0-9]+).*/\1/p')

echo
if [ -n "$DATE" ] && [ "$DATE" != "null" ]; then
  echo "${OK}✓ SUCCESS${RESET}  most recent Sentinel-2 pass: ${BOLD}$DATE${RESET}  (data source: $TYPE, $COUNT features)"
else
  echo "${ERR}✗ STILL EMPTY${RESET}  worker returned no imagery (data source: $TYPE). Investigate further."
fi

echo
echo "${DIM}Open https://abundance.mak-ct.com → Areas → Map sub-tab to see the date in the UI.${RESET}"
echo "${DIM}Press Enter to close.${RESET}"
read -r _ || true
