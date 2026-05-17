#!/usr/bin/env bash
# ============================================================
# Abundance Farm — one-click secret setup
# Double-click this file in Finder, or run from Terminal.
# It will:
#   1. Prompt you for your Anthropic API key   (enables 📸 AI photo diagnosis)
#   2. Prompt you for your Sentinel Hub Instance ID  (enables 🛰️ NDVI overlay)
#   3. Push each as a Cloudflare Worker secret via wrangler
#   4. Redeploy the worker
#   5. Verify both endpoints respond correctly
# Either prompt can be skipped by pressing Enter without typing anything.
# ============================================================

set -e

cd "$(dirname "$0")"

# Colors
BOLD=$'\033[1m'; OK=$'\033[32m'; WARN=$'\033[33m'; ERR=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
say()  { printf "\n${BOLD}==>${RESET} %s\n" "$1"; }
ok()   { printf "${OK}OK${RESET}  %s\n" "$1"; }
warn() { printf "${WARN}!!${RESET}  %s\n" "$1"; }
fail() { printf "${ERR}FAIL${RESET}  %s\n" "$1" >&2; exit 1; }
skip() { printf "${DIM}--${RESET}  %s\n" "$1"; }

clear
echo "${BOLD}Abundance Farm — Secret Setup${RESET}"
echo "${DIM}Working directory: $(pwd)${RESET}"
echo
echo "This will configure two optional features:"
echo "  1. ${BOLD}AI photo diagnosis${RESET}  (Anthropic API key)"
echo "  2. ${BOLD}NDVI satellite overlay${RESET}  (Sentinel Hub Instance ID)"
echo
echo "Either prompt can be skipped — just press Enter to keep that feature disabled."
echo

# ---------- Sanity: Node + wrangler ready ----------
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js not found. Run ./redeploy.command first — it installs Node."
fi
if ! npx --no-install wrangler --version >/dev/null 2>&1; then
  warn "wrangler not loadable — running npm install once"
  npm install --no-audit --no-fund >/dev/null || fail "npm install failed"
fi
ok "wrangler $(npx --no-install wrangler --version 2>/dev/null | head -n1) ready"

# ---------- Sanity: Cloudflare login ----------
say "Cloudflare login check"
if ! npx --no-install wrangler whoami >/dev/null 2>&1; then
  warn "Not logged in. A browser tab will open — click 'Allow' to authorize."
  echo "${DIM}(Press Enter to continue.)${RESET}"
  read -r _ || true
  npx wrangler login || fail "Cloudflare login failed"
fi
WHO=$(npx --no-install wrangler whoami 2>/dev/null | grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' | head -n1)
ok "Logged in as ${WHO:-Cloudflare account}"

# ---------- Step 1: Anthropic API key ----------
say "Step 1: Anthropic API key (for AI photo diagnosis)"
echo "Get a key at:  ${BOLD}https://console.anthropic.com/settings/keys${RESET}"
echo "(Sign in → Create Key → name it 'abundance-farm-worker' → copy the sk-ant-... value)"
echo
echo "Make sure you have at least \$5 of credit:"
echo "  ${BOLD}https://console.anthropic.com/settings/billing${RESET}"
echo "  (~₱0.05–0.10 per photo diagnosis with Haiku vision — plenty for hundreds of photos)"
echo

# Read silently so the key doesn't get printed in scrollback or screenshots
printf "${BOLD}Paste your Anthropic key (or press Enter to skip):${RESET} "
read -rs ANTHROPIC_KEY
echo

if [ -z "$ANTHROPIC_KEY" ]; then
  skip "Skipped Anthropic key — AI diagnosis will remain disabled."
elif [[ "$ANTHROPIC_KEY" != sk-ant-* ]]; then
  warn "That doesn't look like an Anthropic key (should start with 'sk-ant-')."
  printf "Continue anyway? [y/N] "
  read -r CONFIRM
  if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    skip "Aborted Anthropic setup."
    ANTHROPIC_KEY=""
  fi
fi

if [ -n "$ANTHROPIC_KEY" ]; then
  echo "$ANTHROPIC_KEY" | npx --no-install wrangler secret put ANTHROPIC_API_KEY \
    || fail "Could not set ANTHROPIC_API_KEY"
  ok "ANTHROPIC_API_KEY pushed to Cloudflare"
  # Clear key from memory ASAP
  unset ANTHROPIC_KEY
fi

# ---------- Step 2: Sentinel Hub Instance ID ----------
say "Step 2: Sentinel Hub Instance ID (for NDVI satellite overlay)"
echo "Register (free, ~3 minutes) at:"
echo "  ${BOLD}https://dataspace.copernicus.eu/${RESET}  (sign up + verify email)"
echo "Then open the Sentinel Hub dashboard:"
echo "  ${BOLD}https://shapps.dataspace.copernicus.eu/dashboard/${RESET}"
echo "  → Configurations → New configuration"
echo "  → base it on 'Sentinel-2 L2A NDVI' template"
echo "  → save and copy the Instance ID (UUID-style, like 12345678-abcd-...)"
echo

printf "${BOLD}Paste your Sentinel Hub Instance ID (or press Enter to skip):${RESET} "
read -r SENTINEL_ID
echo

if [ -z "$SENTINEL_ID" ]; then
  skip "Skipped Sentinel Hub — NDVI overlay will remain disabled."
elif [[ ! "$SENTINEL_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  warn "That doesn't look like a UUID. Expected format: 12345678-abcd-1234-abcd-1234567890ab"
  printf "Continue anyway? [y/N] "
  read -r CONFIRM
  if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    skip "Aborted Sentinel Hub setup."
    SENTINEL_ID=""
  fi
fi

if [ -n "$SENTINEL_ID" ]; then
  echo "$SENTINEL_ID" | npx --no-install wrangler secret put SENTINEL_HUB_INSTANCE_ID \
    || fail "Could not set SENTINEL_HUB_INSTANCE_ID"
  ok "SENTINEL_HUB_INSTANCE_ID pushed to Cloudflare"

  # The layer ID inside the configuration. "Simple Sentinel-2 L2A template"
  # uses VEGETATION_INDEX. If the user picked a different template or renamed
  # the layer, they can override here. Press Enter to accept the default.
  printf "${BOLD}NDVI layer ID inside that configuration${RESET} ${DIM}[default: VEGETATION_INDEX]:${RESET} "
  read -r LAYER_ID
  if [ -z "$LAYER_ID" ]; then LAYER_ID="VEGETATION_INDEX"; fi
  echo "$LAYER_ID" | npx --no-install wrangler secret put SENTINEL_HUB_LAYER_NAME \
    || fail "Could not set SENTINEL_HUB_LAYER_NAME"
  ok "SENTINEL_HUB_LAYER_NAME pushed (= $LAYER_ID)"
fi

# ---------- Step 3: Google Maps API key ----------
say "Step 3: Google Maps API key (smoother parcel-drawing UX)"
echo "Set up at:"
echo "  ${BOLD}https://console.cloud.google.com/apis/credentials${RESET}"
echo
echo "Steps inside Google Cloud Console:"
echo "  1. Create or select a project"
echo "  2. Enable billing (required — but free tier covers ~28k map loads/month)"
echo "  3. APIs & Services → Library → enable: ${BOLD}Maps JavaScript API${RESET} and ${BOLD}Drawing Library${RESET}"
echo "  4. APIs & Services → Credentials → Create Credentials → API Key"
echo "  5. ${BOLD}Restrict the key${RESET}: Application restrictions → HTTP referrers →"
echo "     add ${BOLD}https://abundance.mak-ct.com/*${RESET} (and any preview URLs you use)"
echo "  6. API restrictions → restrict to ${BOLD}Maps JavaScript API${RESET}"
echo "  7. Copy the key (looks like AIzaSy...)"
echo

printf "${BOLD}Paste your Google Maps API key (or press Enter to skip):${RESET} "
read -r GMAPS_KEY
echo

if [ -z "$GMAPS_KEY" ]; then
  skip "Skipped Google Maps — parcel map will use the Leaflet fallback."
elif [[ ! "$GMAPS_KEY" =~ ^AIza[0-9A-Za-z_-]{30,}$ ]]; then
  warn "That doesn't look like a Google API key (should start with 'AIza')."
  printf "Continue anyway? [y/N] "
  read -r CONFIRM
  if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    skip "Aborted Google Maps setup."
    GMAPS_KEY=""
  fi
fi

if [ -n "$GMAPS_KEY" ]; then
  echo "$GMAPS_KEY" | npx --no-install wrangler secret put GOOGLE_MAPS_API_KEY \
    || fail "Could not set GOOGLE_MAPS_API_KEY"
  ok "GOOGLE_MAPS_API_KEY pushed to Cloudflare"
fi

# ---------- Step 3: Deploy ----------
say "Step 3: Redeploying so the new secrets take effect"
npx --no-install wrangler deploy || fail "wrangler deploy failed"
ok "Deploy complete"

# Give the edge a moment to propagate the new env
sleep 3

# ---------- Step 4: Verify ----------
say "Step 4: Verifying"

# NDVI probe — public, no auth needed
NDVI_PROBE=$(curl -s -o /dev/null -w "%{http_code}" "https://abundance.mak-ct.com/api/ndvi-tile?probe=1" || echo "000")
case "$NDVI_PROBE" in
  200) ok "NDVI overlay: configured ✓ (open any Area → Map → 'Show NDVI')" ;;
  404) skip "NDVI overlay: not configured (you skipped step 2)" ;;
  *)   warn "NDVI probe returned HTTP $NDVI_PROBE — check Cloudflare dashboard if you set this." ;;
esac

# Anthropic — we can't probe without burning tokens, so just check the secret
# was registered by listing existing secrets.
SECRETS_LIST=$(npx --no-install wrangler secret list 2>/dev/null || echo "")
if echo "$SECRETS_LIST" | grep -q '"name": *"ANTHROPIC_API_KEY"'; then
  ok "AI diagnosis: ANTHROPIC_API_KEY is set ✓ (open any Area → Diagnose → upload a photo)"
else
  skip "AI diagnosis: ANTHROPIC_API_KEY not set"
fi
if echo "$SECRETS_LIST" | grep -q '"name": *"GOOGLE_MAPS_API_KEY"'; then
  ok "Google Maps: GOOGLE_MAPS_API_KEY is set ✓ (Area → Map sub-tab now uses Google)"
else
  skip "Google Maps: GOOGLE_MAPS_API_KEY not set — Leaflet fallback in use"
fi

echo
echo "${BOLD}${OK}Setup complete!${RESET}"
echo
echo "What's live now:"
echo "  📸 ${BOLD}Diagnose${RESET}  — Areas → Diagnose sub-tab → upload a leaf/pest photo"
echo "  🛰️ ${BOLD}NDVI Map${RESET} — Areas → Map sub-tab → 'Show NDVI' (after drawing your parcel polygon)"
echo
echo "Open the app: ${BOLD}https://abundance.mak-ct.com${RESET}"
echo "${DIM}Cmd+Shift+R for a hard refresh.${RESET}"
echo
echo "${DIM}Press Enter to close this window.${RESET}"
read -r _ || true
