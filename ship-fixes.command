#!/usr/bin/env bash
# ============================================================
# Abundance Farm — ship the shakedown-test fixes
# Double-click in Finder, or run from Terminal:  bash ship-fixes.command
#
# What this does:
#   1. Show a summary of what's changed (so you see before you ship)
#   2. Run npm test — must pass before pushing
#   3. git add + commit + push to main
#   4. GitHub Actions takes over from there and deploys to
#      abundance.mak-ct.com within ~30 seconds.
#
# What it does NOT do:
#   - Rotate the Google Maps API key (manual GCP Console work)
#   - Touch your Cloudflare secrets (use redeploy.command for that)
# ============================================================

set -e

cd "$(dirname "$0")"

BOLD=$'\033[1m'; OK=$'\033[32m'; WARN=$'\033[33m'; ERR=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
say()  { printf "\n${BOLD}==>${RESET} %s\n" "$1"; }
ok()   { printf "${OK}OK${RESET}  %s\n" "$1"; }
warn() { printf "${WARN}!!${RESET}  %s\n" "$1"; }
fail() { printf "${ERR}FAIL${RESET}  %s\n" "$1" >&2; exit 1; }

clear
echo "${BOLD}Abundance Farm — Ship Shakedown Fixes${RESET}"
echo "${DIM}Working directory: $(pwd)${RESET}"
echo

# ---------- Step 1: status preview ----------
say "Step 1 of 4: Preview what's about to ship"
if ! git diff --quiet --exit-code || [ -n "$(git status --porcelain)" ]; then
  echo "${DIM}-------------------------------------------------------${RESET}"
  git status --short
  echo "${DIM}-------------------------------------------------------${RESET}"
  echo "Changed files (line-count diff):"
  git diff --stat
  echo "${DIM}-------------------------------------------------------${RESET}"
else
  warn "No local changes detected. Nothing to ship."
  exit 0
fi

echo
read -p "Continue? [y/N] " ANSWER
[[ "$ANSWER" =~ ^[Yy]$ ]] || { warn "Cancelled by user."; exit 0; }

# ---------- Step 2: tests must pass ----------
say "Step 2 of 4: Running smoke + FAA-unit tests"
if [ ! -d node_modules ]; then
  warn "node_modules missing; running npm ci"
  npm ci --silent
fi
npm test || fail "Tests failed — refusing to push. Fix tests first."
ok "All tests passed"

# ---------- Step 3: commit ----------
say "Step 3 of 4: Commit"
git add -A

# Default commit message — overrideable
DEFAULT_MSG="Apply shakedown-test fixes

- Fix FAA unit-parsing bug (\"4600 mL\".includes(\"l\") was matching the L in mL,
  treating 4600 mL as 4600 L on Dashboard/Cashflow/Advisor — 1000× off).
- Wire Accounting Cash Flow to actual purchase amounts at farm level
  (previously used FIFO consumption, hiding the real bank-account impact).
- Wire NFA floor read on Forecasts to nfaFloor.nfa.{palayDry,palayFresh}
  (was reading nfaFloor.dry / .fresh which never existed → floor was a no-op).
- Map: surface InvalidKeyMapError with actionable instructions instead of
  a gray box (gm_authFailure + gm-err-container DOM probe).
- Cosmetic: dynamic Tasks heading, Areas badge counts areas-with-overdue
  (not raw task count), float .toFixed on Totals, kg/L lot display rounding.
- Backfill milling % on existing breeds when '+ Populate common' is clicked.
- Worker /api/me: replace userCount leak with boolean needsBootstrap.
- Add periodic 30s /api/ops pull for cross-device sync (visibilitychange + setInterval).
- Add test/faa-units.mjs regression guard."

echo
echo "Default commit message:"
echo "${DIM}$DEFAULT_MSG${RESET}"
echo
read -p "Use this message? [Y/n] " USE_DEFAULT
if [[ "$USE_DEFAULT" =~ ^[Nn]$ ]]; then
  read -p "Enter your message (single line): " CUSTOM_MSG
  git commit -m "$CUSTOM_MSG" || fail "git commit failed"
else
  git commit -m "$DEFAULT_MSG" || fail "git commit failed"
fi
ok "Committed"

# ---------- Step 4: push ----------
say "Step 4 of 4: Push to main (auto-deploy via GitHub Actions)"
git push origin main || fail "git push failed — check network or credentials"
ok "Pushed"

echo
echo "${OK}${BOLD}Done.${RESET}"
echo "GitHub Actions is now deploying to ${BOLD}abundance.mak-ct.com${RESET}."
echo "Watch progress: ${DIM}https://github.com/Phelicskit/abundance-farm/actions${RESET}"
echo
echo "Reminder: the Google Maps key still needs to be rotated/fixed in GCP"
echo "Console for the Map view to render. The new error UI now tells you how."
echo

# Keep the Terminal window open when launched from Finder
if [ -t 0 ]; then
  echo "Press Enter to close…"
  read -r
fi
