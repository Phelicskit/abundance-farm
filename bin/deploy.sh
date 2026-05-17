#!/usr/bin/env bash
# Idempotent deploy for the Abundance Farm Worker.
# Safe to run on first deploy AND on every update.
#
# Usage:
#   bin/deploy.sh                 normal deploy
#   bin/deploy.sh --skip-tests    skip the smoke test (use sparingly)
#   bin/deploy.sh --rotate-secret force a new ADMIN_SECRET
#   bin/deploy.sh --dry-run       walk through the steps without deploying

set -euo pipefail

# --- locate project root regardless of where the user invoked from ---
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

# --- flags ---
SKIP_TESTS=0
ROTATE_SECRET=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --rotate-secret) ROTATE_SECRET=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      echo "Usage: bin/deploy.sh [--skip-tests] [--rotate-secret] [--dry-run]"
      exit 0
      ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# --- terminal colors (only when stdout is a tty) ---
if [ -t 1 ]; then
  C_DIM=$'\033[2m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
else
  C_DIM=""; C_OK=""; C_WARN=""; C_ERR=""; C_RESET=""; C_BOLD=""
fi
step() { printf "\n${C_BOLD}>> %s${C_RESET}\n" "$1"; }
ok()   { printf "${C_OK}OK${C_RESET}  %s\n" "$1"; }
warn() { printf "${C_WARN}WARN${C_RESET}  %s\n" "$1"; }
fail() { printf "${C_ERR}FAIL${C_RESET}  %s\n" "$1" >&2; exit 1; }
say()  { printf "${C_DIM}    %s${C_RESET}\n" "$1"; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf "${C_DIM}    [dry-run] %s${C_RESET}\n" "$*"; else eval "$@"; fi; }

# --- prerequisites ---
step "Checking prerequisites"
command -v node    >/dev/null || fail "node is not installed (need v18+). Install from https://nodejs.org"
command -v npm     >/dev/null || fail "npm is not installed"
command -v openssl >/dev/null || fail "openssl is not installed"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || fail "node v$NODE_MAJOR is too old; need v18 or newer"
ok "node v$(node -p 'process.versions.node'), npm, openssl all present"

# --- install dependencies if needed ---
step "Installing dependencies (only if needed)"
if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
  run "npm install"
  ok "dependencies installed"
else
  ok "node_modules is up to date"
fi

# --- offline smoke test ---
if [ "$SKIP_TESTS" = 0 ]; then
  step "Running offline smoke test (auth + role logic)"
  if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] node test/smoke.mjs"
  else
    if ! node test/smoke.mjs; then
      fail "Smoke test failed. Aborting deploy. Use --skip-tests to override."
    fi
  fi
  ok "smoke test passed"
else
  warn "skipping smoke test (--skip-tests)"
fi

# --- wrangler login state ---
step "Verifying Cloudflare authentication"
if [ "$DRY_RUN" = 1 ]; then
  say "[dry-run] npx --no-install wrangler whoami"
else
  if ! npx --no-install wrangler whoami >/dev/null 2>&1; then
    warn "You are not logged in to Cloudflare. Running 'npx wrangler login' in a moment."
    say  "A browser window will open. Approve the request, then come back here."
    npx wrangler login
  fi
  WHO=$(npx --no-install wrangler whoami 2>/dev/null | tr -d '\n' | grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' | head -n1)
  ok "logged in as ${WHO:-Cloudflare account}"
fi

# --- secret check ---
step "Checking ADMIN_SECRET"
HAS_SECRET=0
if [ "$DRY_RUN" = 0 ]; then
  if npx --no-install wrangler secret list 2>/dev/null | grep -q '"name": *"ADMIN_SECRET"\|name: ADMIN_SECRET'; then
    HAS_SECRET=1
  fi
fi

if [ "$ROTATE_SECRET" = 1 ] || [ "$HAS_SECRET" = 0 ]; then
  if [ "$ROTATE_SECRET" = 1 ]; then
    warn "Rotating ADMIN_SECRET as requested."
  else
    warn "ADMIN_SECRET not set on the Worker yet."
  fi
  NEW=$(openssl rand -hex 32)
  printf "\n${C_BOLD}New ADMIN_SECRET (write this down NOW — it is only shown once):${C_RESET}\n"
  printf "${C_OK}%s${C_RESET}\n\n" "$NEW"
  if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] (would pipe secret to wrangler secret put ADMIN_SECRET)"
  else
    say "Press Enter to upload it to Cloudflare, or Ctrl+C to abort."
    read -r _ || true
    printf "%s" "$NEW" | npx --no-install wrangler secret put ADMIN_SECRET
  fi
  ok "ADMIN_SECRET stored on the Worker"
  unset NEW
else
  ok "ADMIN_SECRET already set (use --rotate-secret to replace it)"
fi

# --- deploy ---
step "Deploying to Cloudflare"
if [ "$DRY_RUN" = 1 ]; then
  say "[dry-run] npx --no-install wrangler deploy"
else
  npx --no-install wrangler deploy
fi
ok "deployed"

# --- post-deploy hint ---
step "Smoke test the deployed Worker"
WORKER_NAME=$(awk -F'"' '/^name *=/{print $2; exit}' wrangler.toml)
DOMAIN_HINT="${WORKER_NAME}.<your-subdomain>.workers.dev"
if [ "$DRY_RUN" = 0 ] && command -v curl >/dev/null; then
  WHO_FULL=$(npx --no-install wrangler whoami 2>/dev/null || true)
  SUB=$(printf "%s" "$WHO_FULL" | grep -oE '[A-Za-z0-9_-]+\.workers\.dev' | head -n1)
  if [ -n "${SUB:-}" ]; then
    URL="https://${WORKER_NAME}.${SUB%%.workers.dev}.workers.dev"
    say "GET $URL/api/health"
    if curl -sf -o /dev/null "$URL/api/health"; then
      ok "Worker is responding at $URL"
      say "Open $URL in a browser to start the first-time setup."
    else
      warn "Could not reach $URL/api/health yet. DNS may take 30-60s."
    fi
  else
    say "Open https://${DOMAIN_HINT}/api/health in a browser to verify."
  fi
fi

cat <<EOF

${C_BOLD}Next steps${C_RESET}
  1. Open the Worker URL printed above (or https://abundance.mak-ct.com if your custom domain is attached).
  2. The login screen shows ${C_BOLD}First-time setup${C_RESET} because no users exist yet.
     Paste the ADMIN_SECRET shown above to create the Owner account.
  3. To attach the custom domain abundance.mak-ct.com:
     Cloudflare dashboard -> Workers and Pages -> ${WORKER_NAME} -> Settings -> Domains and Routes -> Add Custom Domain.

${C_DIM}Re-run this script anytime after edits: bin/deploy.sh${C_RESET}
EOF
