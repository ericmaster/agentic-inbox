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
	// Per-domain Resend accounts: JSON map of sending-domain → secret prefix, e.g.
	// {"ericmaster.ninja":"RESEND_ERICMASTER_NINJA"}. For each mapped domain the
	// Worker reads `<PREFIX>_API_KEY` (send) and `<PREFIX>_WEBHOOK_SECRET` (webhook
	// verification) — both Worker secrets. Unmapped domains use RESEND_API_KEY /
	// RESEND_WEBHOOK_SECRET. The dynamically-named secrets are not declared here;
	// see lib/resendKeys.ts. Leave unset for a single shared Resend account.
	RESEND_DOMAIN_KEYS: Cloudflare.Env["RESEND_DOMAIN_KEYS"];
	// NOTE: the `DELIVERY_MAP` KV binding (Resend `re_…` id → {mailboxId,
	// emailId, threadId}) is declared in wrangler.jsonc and therefore generated
	// into Cloudflare.Env by `wrangler types` — do not redeclare it here.
}
