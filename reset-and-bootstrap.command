#!/usr/bin/env bash
# ============================================================
# Abundance Farm — fresh-reset script
# ============================================================
# What this does, in order:
#   1. Generates a brand-new ADMIN_SECRET and uploads it to your Worker
#   2. Wipes the `users` key from the PRICES KV namespace
#      (your price log, areas, harvest data — all that stays. Only the
#       user accounts are cleared.)
#   3. Prints the new ADMIN_SECRET on screen — copy it RIGHT AWAY,
#      it is only shown once.
#
# After the script finishes, open https://abundance.mak-ct.com,
# hard-refresh with Cmd+Shift+R, you should see "First-time setup",
# paste the new secret + your name/email/password, create the Owner.
# ============================================================

set -e

cd "$(dirname "$0")"

BOLD=$'\033[1m'; OK=$'\033[32m'; WARN=$'\033[33m'; ERR=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
say()  { printf "\n${BOLD}==>${RESET} %s\n" "$1"; }
ok()   { printf "${OK}OK${RESET}  %s\n" "$1"; }
warn() { printf "${WARN}!!${RESET}  %s\n" "$1"; }
fail() { printf "${ERR}FAIL${RESET}  %s\n" "$1" >&2; exit 1; }

clear
echo "${BOLD}Abundance Farm — Fresh Reset${RESET}"
echo "${DIM}Working directory: $(pwd)${RESET}"
echo

# Prereq: wrangler must be installed (redeploy.command already did this)
command -v node >/dev/null 2>&1 || fail "Node not found. Run ./redeploy.command first."
npx --no-install wrangler --version >/dev/null 2>&1 || fail "wrangler not installed. Run ./redeploy.command first."

# Read KV namespace id from wrangler.toml
KV_ID=$(awk -F'"' '/^[[:space:]]*id[[:space:]]*=/{print $2; exit}' wrangler.toml)
[ -n "$KV_ID" ] || fail "Could not read KV namespace id from wrangler.toml"
ok "KV namespace: $KV_ID"

# Make sure user is logged in
say "Checking Cloudflare login"
if ! npx --no-install wrangler whoami >/dev/null 2>&1; then
  warn "Not logged in. A browser tab will open — click 'Allow'."
  npx wrangler login || fail "Cloudflare login failed"
fi
WHO=$(npx --no-install wrangler whoami 2>/dev/null | grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' | head -n1)
ok "Logged in as ${WHO:-Cloudflare account}"

# Confirmation
say "About to do the following — this is destructive:"
echo "    • rotate ADMIN_SECRET on the abundance-prices Worker"
echo "    • delete the 'users' key from KV namespace $KV_ID"
echo "    • everything else (price log, areas, harvest data) stays untouched"
echo
echo -n "${BOLD}Type YES to continue: ${RESET}"
read -r CONFIRM
CONFIRM_UPPER=$(printf "%s" "$CONFIRM" | tr '[:lower:]' '[:upper:]')
[ "$CONFIRM_UPPER" = "YES" ] || fail "Cancelled by user."

# Generate new secret
say "Step 1 of 3: Generating new ADMIN_SECRET"
NEW_SECRET=$(openssl rand -hex 32)
ok "new secret generated"

# Upload to Cloudflare
say "Step 2 of 3: Uploading secret to Worker"
printf "%s" "$NEW_SECRET" | npx --no-install wrangler secret put ADMIN_SECRET || fail "secret put failed"
ok "ADMIN_SECRET stored on Worker"

# Wipe users from KV
say "Step 3 of 3: Wiping users from KV"
# `kv key delete` returns non-zero if the key doesn't exist; ignore that.
if npx --no-install wrangler kv key delete --namespace-id="$KV_ID" --remote users 2>&1 | tee /tmp/kv-delete.log | grep -q "Success\|deleted\|key has been deleted"; then
  ok "users key deleted"
elif grep -qi "not found\|does not exist\|404" /tmp/kv-delete.log; then
  ok "users key was already empty"
else
  cat /tmp/kv-delete.log
  warn "could not confirm deletion — check the output above"
fi

# Output
echo
echo "${BOLD}${OK}════════════════════════════════════════════════════════════════${RESET}"
echo "${BOLD}${OK}DONE.${RESET}"
echo "${BOLD}${OK}════════════════════════════════════════════════════════════════${RESET}"
echo
echo "${BOLD}New ADMIN_SECRET (copy this NOW — it's only shown once):${RESET}"
echo
echo "${OK}${BOLD}$NEW_SECRET${RESET}"
echo
echo "${BOLD}Next steps:${RESET}"
echo "  1. Open ${BOLD}https://abundance.mak-ct.com${RESET}"
echo "  2. Hard-refresh with ${BOLD}Cmd+Shift+R${RESET}"
echo "  3. You should see 'First-time setup · create the Owner account'"
echo "  4. Paste the ADMIN_SECRET above into the field labelled"
echo "     ${DIM}'Worker ADMIN_SECRET (one-time)'${RESET}"
echo "  5. Fill in your name, email, and a new password (8+ chars)"
echo "  6. Click create — you'll be logged in as Owner"
echo
echo "${DIM}Press Enter to close this window.${RESET}"
read -r _ || true
