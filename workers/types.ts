// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	// Nimblersoft bridge integration (agentic-inbox-bridge). Optional: when unset,
	// webhook emission is skipped (vanilla upstream behaviour). WEBHOOK_SECRET is a
	// Worker secret (`wrangler secret put WEBHOOK_SECRET`), not a committed var.
	WEBHOOK_URL?: string;
	WEBHOOK_SECRET?: string;
	// Outbound provider selection. Default "cloudflare" (the `EMAIL` binding).
	// "resend" routes sends through the Resend HTTP API; on a 429/5xx/network
	// failure it falls back to Cloudflare when EMAIL_FALLBACK_CLOUDFLARE="true".
	// RESEND_API_KEY / RESEND_WEBHOOK_SECRET are Worker secrets, not committed vars.
	EMAIL_PROVIDER?: "cloudflare" | "resend";
	EMAIL_FALLBACK_CLOUDFLARE?: string; // "true" to enable CF fallback
	RESEND_API_KEY?: string;
	RESEND_WEBHOOK_SECRET?: string;
	// NOTE: the `DELIVERY_MAP` KV binding (Resend `re_…` id → {mailboxId,
	// emailId, threadId}) is declared in wrangler.jsonc and therefore generated
	// into Cloudflare.Env by `wrangler types` — do not redeclare it here.
}
