#!/usr/bin/env bash
# ============================================================
# One-shot Google Maps wiring for Abundance Farm.
# Created automatically after Chrome captured your API key.
# Pushes the key to Cloudflare as a Worker secret and redeploys.
# Safe to re-run; will overwrite the existing secret with the same value.
# ============================================================

set -e
cd "$(dirname "$0")"

BOLD=$'\033[1m'; OK=$'\033[32m'; ERR=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'

KEY="AIzaSyCicPmLaVbe1W39B0wmi4limBwQPTGdJGM"

echo "${BOLD}Abundance Farm — Google Maps wire-up${RESET}"
echo "${DIM}Working directory: $(pwd)${RESET}"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "${ERR}Node.js not found. Run ./redeploy.command first.${RESET}"; exit 1
fi
if ! npx --no-install wrangler --version >/dev/null 2>&1; then
  echo "Installing dependencies once..."; npm install --no-audit --no-fund >/dev/null
fi
echo "${OK}OK${RESET}  wrangler $(npx --no-install wrangler --version 2>/dev/null | head -n1)"

if ! npx --no-install wrangler whoami >/dev/null 2>&1; then
  echo "Not logged in to Cloudflare — running wrangler login..."
  npx wrangler login
fi

echo "Pushing GOOGLE_MAPS_API_KEY..."
echo "$KEY" | npx --no-install wrangler secret put GOOGLE_MAPS_API_KEY
echo "${OK}OK${RESET}  secret pushed"

echo "Deploying..."
npx --no-install wrangler deploy
echo "${OK}OK${RESET}  deployed"

echo
echo "${BOLD}${OK}Done!${RESET}  Open https://abundance.mak-ct.com → Areas → Map sub-tab"
echo "${DIM}Cmd+Shift+R for a hard refresh.${RESET}"
echo
read -r -p "Press Enter to close..."
