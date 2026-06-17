// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "../types";

// Fire-and-forget notifier to the external Nimblersoft bridge
// (agentic-inbox-bridge). No-ops when WEBHOOK_URL is unset, so local dev and
// vanilla upstream deploys are unaffected. The shared X-Webhook-Secret lets the
// bridge authenticate the caller. Errors are logged, never thrown — callers
// wrap this in ctx.waitUntil() and must not let webhook delivery break mail flow.
export async function notifyBridge(env: Env, payload: Record<string, unknown>): Promise<void> {
	if (!env.WEBHOOK_URL) return;
	try {
		const res = await fetch(env.WEBHOOK_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(env.WEBHOOK_SECRET ? { "X-Webhook-Secret": env.WEBHOOK_SECRET } : {}),
			},
			body: JSON.stringify(payload),
		});
		if (!res.ok) console.error(`Bridge webhook ${payload.event} failed: ${res.status}`);
	} catch (e) {
		console.error(`Bridge webhook ${payload.event} error:`, (e as Error).message);
	}
}
