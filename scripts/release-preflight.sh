#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# RX Store — production secrets pre-flight (production gate §8).
#
# Runs LOCALLY against the real deployment and reports which capabilities are
# fully configured BEFORE a release/deploy. NEVER prints secret VALUES — only
# their presence. Exit code 1 only when a MANDATORY item is missing.
#
# Usage (from the repository root):
#   ./scripts/release-preflight.sh            # check the deployed Worker
#   ./scripts/release-preflight.sh --local    # also check local release env
# ---------------------------------------------------------------------------
set -uo pipefail

BOLD=$'\033[1m'; DIM=$'\033[2m'; OK=$'\033[32m'; WARN=$'\033[33m'; BAD=$'\033[31m'; RST=$'\033[0m'
FAILURES=0
WARNINGS=0

row() { # status name detail mandatory(0/1)
  local status="$1" name="$2" detail="$3" mandatory="$4"
  case "$status" in
    ok)     printf "  ${OK}PASS${RST}  %-28s %s\n" "$name" "$detail" ;;
    warn)   printf "  ${WARN}WARN${RST}  %-28s %s\n" "$name" "$detail"; WARNINGS=$((WARNINGS+1)) ;;
    fail)   printf "  ${BAD}FAIL${RST}  %-28s %s\n" "$name" "$detail"
            if [ "$mandatory" = "1" ]; then FAILURES=$((FAILURES+1)); else WARNINGS=$((WARNINGS+1)); fi ;;
  esac
}

echo "${BOLD}RX Store production pre-flight$(RST)"
echo "$(DIM)Secret VALUES are never printed — only presence.$(RST)"
echo

# ---- Worker secrets (via wrangler; read-only) -----------------------------
if command -v npx >/dev/null 2>&1; then
  SECRETS="$(npx wrangler secret list --config backend/wrangler.toml 2>/dev/null | tr -d ' ",' | cut -d: -f1 | grep -v '^\[' | grep -v '^$' || true)"
else
  SECRETS=""
fi
has() { echo "$SECRETS" | grep -qx "$1" && return 0 || return 1; }

echo "Cloudflare Worker (rx-store-api):"
has JWT_SECRET          && row ok    "JWT_SECRET" "session signing configured" 1 || row fail "JWT_SECRET" "MISSING — no authenticated API at all" 1
has VIRUSTOTAL_API_KEY  && row ok    "VIRUSTOTAL_API_KEY" "malware scanning active (hash lookup)" 0 || row warn "VIRUSTOTAL_API_KEY" "absent — package security reports UNAVAILABLE (admin override required to publish)" 0
has PAYSTACK_SECRET_KEY && row ok    "PAYSTACK_SECRET_KEY" "payments active" 0 || row warn "PAYSTACK_SECRET_KEY" "absent — purchases fail closed (no paid sales possible)" 0
has RESEND_API_KEY      && row ok    "RESEND_API_KEY" "email delivery possible" 0 || row warn "RESEND_API_KEY" "absent — password-reset email + release emails skipped" 0
has FROM_EMAIL          && row ok    "FROM_EMAIL" "sender identity configured" 0 || row warn "FROM_EMAIL" "absent — email sending skipped" 0
has NVIDIA_API_KEY || has OPENAI_API_KEY || has OPENROUTER_API_KEY || has GEMINI_API_KEY \
                        && row ok    "AI provider key" "at least one provider configured" 0 || row warn "AI provider key" "none — AI chat falls back / disabled" 0
echo

# ---- Worker vars (from wrangler.toml) --------------------------------------
echo "Worker configuration (backend/wrangler.toml):"
grep -q '^ENVIRONMENT = "production"' backend/wrangler.toml \
  && row ok "ENVIRONMENT" "production" 1 || row fail "ENVIRONMENT" "not set to production" 1
CORS="$(grep '^CORS_ALLOWED_ORIGINS' backend/wrangler.toml | cut -d'"' -f2)"
[ -n "$CORS" ] && [ "$CORS" != "https://rx-store-web.pages.dev" ] \
  && row warn "CORS_ALLOWED_ORIGINS" "custom value: $CORS (verify it is intentional)" 0
[ -n "$CORS" ] && [ "$CORS" = "https://rx-store-web.pages.dev" ] \
  && row ok "CORS_ALLOWED_ORIGINS" "production web origin" 0 || true
grep -q '^RX_STORE_WEB_URL = "https://' backend/wrangler.toml \
  && row ok "RX_STORE_WEB_URL" "update-check store links" 0 || row fail "RX_STORE_WEB_URL" "missing — SDK storeUrl/deep-link fallbacks degrade" 0
grep -q '^MALWARE_SCANNER' backend/wrangler.toml \
  && row ok "MALWARE_SCANNER" "scanner selection present" 0 || row fail "MALWARE_SCANNER" "missing from [vars] (must live INSIDE the [vars] table)" 0
echo

# ---- Frontend ---------------------------------------------------------------
echo "Frontend:"
API_URL="$(grep -E '^VITE_API_URL' .env.production 2>/dev/null | cut -d= -f2)"
case "$API_URL" in
  https://*) row ok "VITE_API_URL (.env.production)" "$API_URL" 1 ;;
  *)         row fail "VITE_API_URL (.env.production)" "missing or not HTTPS — production web build refuses to compile" 1 ;;
esac
echo

# ---- Release signing (GitHub repo secrets cannot be listed without admin
#      API access — check what the last release actually proves) -------------
echo "Release signing (from the latest GitHub release, if any):"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  LATEST="$(gh release list --repo g2code33/Rx-STORE --limit 1 2>/dev/null | head -1 || true)"
  if [ -n "$LATEST" ]; then
    echo "  $(DIM)latest release: $(echo "$LATEST" | tr -s ' ' | cut -d' ' -f1-3)$(RST)"
    NOTES="$(gh release view --repo g2code33/Rx-STORE --json body --jq .body 2>/dev/null || true)"
    echo "$NOTES" | grep -qi "UNSIGNED" \
      && row warn "Windows code signing" "latest release labelled UNSIGNED — set WIN_CSC_LINK_B64 + WIN_CSC_KEY_PASSWORD for signed installers" 0 \
      || echo "  $(DIM)check the release notes for the signing label$(RST)"
  else
    echo "  $(DIM)no releases yet$(RST)"
  fi
  row warn "Android signing secrets" "verify ANDROID_KEYSTORE_BASE64/…_PASSWORD/_ALIAS/_KEY_PASSWORD exist — release.yml fails closed without them" 0
else
  echo "  $(DIM)gh CLI not authenticated — skipped$(RST)"
fi
echo

# ---- Summary ----------------------------------------------------------------
if [ "$FAILURES" -gt 0 ]; then
  echo "${BAD}${BOLD}NOT READY:${RST} $FAILURES mandatory item(s) missing."
  exit 1
fi
echo "${OK}${BOLD}READY:${RST} mandatory items configured ($WARNINGS warning(s))."
[ "$WARNINGS" -gt 0 ] && echo "  $(DIM)Warnings list optional capabilities that are currently degraded — see above.$(RST)"
exit 0
