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
}
