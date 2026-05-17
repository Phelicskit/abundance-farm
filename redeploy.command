#!/usr/bin/env bash
# ============================================================
# Abundance Farm — one-click redeploy
# Double-click this file in Finder, or run from Terminal.
# It will:
#   1. Install Node.js (if missing) using the official Apple .pkg installer
#   2. Install project dependencies
#   3. Log you into Cloudflare (opens a browser tab — click "Allow")
#   4. Deploy abundance-farm/public/index.html to abundance.mak-ct.com
# ============================================================

set -e

# Move to the script's own directory (abundance-farm/)
cd "$(dirname "$0")"

# Colors
BOLD=$'\033[1m'; OK=$'\033[32m'; WARN=$'\033[33m'; ERR=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
say()  { printf "\n${BOLD}==>${RESET} %s\n" "$1"; }
ok()   { printf "${OK}OK${RESET}  %s\n" "$1"; }
warn() { printf "${WARN}!!${RESET}  %s\n" "$1"; }
fail() { printf "${ERR}FAIL${RESET}  %s\n" "$1" >&2; exit 1; }

clear
echo "${BOLD}Abundance Farm — Redeploy${RESET}"
echo "${DIM}Working directory: $(pwd)${RESET}"
echo

# ---------- Step 1: Node.js ----------
say "Step 1 of 4: Checking Node.js"

if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" -ge 18 ] 2>/dev/null; then
  ok "Node $(node --version) already installed"
else
  warn "Node.js not found (or too old). Installing the latest LTS now."
  echo "${DIM}    macOS will ask for your login password to install Node.${RESET}"

  # Pick the correct architecture
  ARCH="$(uname -m)"
  case "$ARCH" in
    arm64) NODE_PKG_URL="https://nodejs.org/dist/v22.11.0/node-v22.11.0.pkg" ;;
    x86_64) NODE_PKG_URL="https://nodejs.org/dist/v22.11.0/node-v22.11.0.pkg" ;;
    *) fail "Unsupported architecture: $ARCH" ;;
  esac

  PKG_PATH="/tmp/node-installer.pkg"
  echo "${DIM}    Downloading $NODE_PKG_URL${RESET}"
  curl -L -# -o "$PKG_PATH" "$NODE_PKG_URL" || fail "Could not download Node installer"

  echo "${DIM}    Running installer (sudo will prompt for your password)...${RESET}"
  sudo installer -pkg "$PKG_PATH" -target / || fail "Node installer failed"

  # Refresh PATH so node is available in this same shell
  export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
  hash -r

  command -v node >/dev/null 2>&1 || fail "Node was installed but not on PATH. Close this Terminal and re-run."
  ok "Installed Node $(node --version)"
fi

# ---------- Step 2: npm install ----------
say "Step 2 of 4: Installing project dependencies"

# Always run npm install — it's fast when nothing is missing, and the previous
# mtime-based check skipped this step even when packages were missing.
npm install --no-audit --no-fund || fail "npm install failed"

# Sanity-check: wrangler must actually be loadable. If a transitive dep is
# missing (e.g. partial prior install), wipe node_modules and reinstall clean.
if ! npx --no-install wrangler --version >/dev/null 2>&1; then
  warn "wrangler isn't loadable — doing a clean reinstall"
  rm -rf node_modules package-lock.json
  npm install --no-audit --no-fund || fail "clean npm install failed"
  npx --no-install wrangler --version >/dev/null 2>&1 || fail "wrangler still won't load after clean install"
fi
ok "wrangler $(npx --no-install wrangler --version 2>/dev/null | head -n1) ready"

# ---------- Step 3: Cloudflare login ----------
say "Step 3 of 4: Cloudflare login"
if npx --no-install wrangler whoami >/dev/null 2>&1; then
  WHO=$(npx --no-install wrangler whoami 2>/dev/null | grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' | head -n1)
  ok "Already logged in as ${WHO:-Cloudflare account}"
else
  warn "Not logged in. A browser tab will open in a moment — click 'Allow' to authorize."
  echo "${DIM}    (Press Enter to continue.)${RESET}"
  read -r _ || true
  npx wrangler login || fail "Cloudflare login failed"
  ok "Cloudflare login complete"
fi

# ---------- Step 4: Deploy ----------
say "Step 4 of 4: Deploying to Cloudflare"
npx --no-install wrangler deploy || fail "wrangler deploy failed"
ok "Deploy complete"

echo
echo "${BOLD}${OK}All done!${RESET}"
echo
echo "Open ${BOLD}https://abundance.mak-ct.com${RESET} in your browser."
echo "${DIM}Tip: hard-refresh with Cmd+Shift+R to clear any cached version.${RESET}"
echo
echo "${DIM}Press Enter to close this window.${RESET}"
read -r _ || true
