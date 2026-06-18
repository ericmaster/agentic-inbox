#!/usr/bin/env bash
#
# Canonical deploy for agentic-inbox — use this (or `npm run deploy`, which calls it).
#
# WHY THIS EXISTS — the var-wipe footgun:
#   `EMAIL_PROVIDER=resend` and `EMAIL_FALLBACK_CLOUDFLARE=true` live as Worker
#   vars set OUT OF BAND (not in wrangler.jsonc — committing them makes
#   `wrangler types` emit literal types that conflict with the optional Env
#   fields). wrangler's DEFAULT deploy behaviour DELETES any var not present in
#   the config before applying the config's vars. So a bare `wrangler deploy`
#   (or the old `npm run deploy`) would drop EMAIL_PROVIDER and silently revert
#   live nimblerbot.com outbound to the 452-blocked Cloudflare path.
#
# DOUBLE PROTECTION:
#   1. `keep_vars: true` in wrangler.jsonc        → protects EVERY deploy path.
#   2. `--keep-vars` here                          → belt-and-suspenders.
#   3. Post-deploy verification (below)            → fails loudly if a critical
#      var went missing, when a Cloudflare token is available.
#
# Usage:  scripts/deploy.sh            # build + safe deploy + verify
#         scripts/deploy.sh --dry-run  # extra args pass through to wrangler
set -euo pipefail
cd "$(dirname "$0")/.."

REQUIRED_VARS=("EMAIL_PROVIDER" "EMAIL_FALLBACK_CLOUDFLARE" "DOMAINS")

echo "════════════════════════════════════════════════════════════════════"
echo " agentic-inbox safe deploy — vars are PRESERVED (keep_vars)."
echo " Never run a bare 'wrangler deploy' without --keep-vars on this Worker."
echo "════════════════════════════════════════════════════════════════════"

echo "▶ build…"
npm run build

echo "▶ deploy (--keep-vars)…"
npx wrangler deploy --keep-vars "$@"

# Post-deploy verification. Best-effort: only runs when a Cloudflare API token
# with Workers Scripts:Read is available (agents have one via Infisical; humans
# can `export CLOUDFLARE_API_TOKEN=…`). keep_vars already guarantees safety; this
# just turns a silent regression into a loud failure.
TOKEN="${CLOUDFLARE_API_TOKEN:-}"
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-71f942c5eebea605ba6f422431504a80}"
if [[ -z "$TOKEN" ]]; then
	echo "ℹ post-deploy var check skipped (set CLOUDFLARE_API_TOKEN to enable)."
	echo "✔ deploy complete."
	exit 0
fi

echo "▶ verifying critical vars survived…"
SETTINGS="$(curl -sS --http1.1 -H "Authorization: Bearer $TOKEN" \
	"https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/agentic-inbox/settings")"

missing=0
for v in "${REQUIRED_VARS[@]}"; do
	if echo "$SETTINGS" | python3 -c "
import sys,json
d=json.load(sys.stdin).get('result',{})
names={b.get('name') for b in d.get('bindings',[])}
sys.exit(0 if '$v' in names else 1)
"; then
		echo "  ✔ $v present"
	else
		echo "  ✖ $v MISSING — outbound config may be broken!"
		missing=1
	fi
done

if [[ "$missing" -ne 0 ]]; then
	echo "✖ DEPLOY VERIFICATION FAILED — a required var is missing."
	echo "  Re-set it, e.g.: npx wrangler deploy --keep-vars --var EMAIL_PROVIDER:resend --var EMAIL_FALLBACK_CLOUDFLARE:true"
	exit 1
fi
echo "✔ deploy complete; all critical vars preserved."
