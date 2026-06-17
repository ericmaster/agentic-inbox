// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Resend delivery-event webhook receiver.
 *
 * Resend posts `email.delivered` / `email.bounced` / `email.complained` /
 * `email.delivery_delayed` events here (configured in the Resend dashboard →
 * `https://ainbox.nimblerbot.com/webhooks/resend`). We verify the Svix
 * signature, correlate the Resend message id (`data.email_id`) back to the
 * original send via the DELIVERY_MAP KV, and forward an `email-delivery-status`
 * event to the bridge so it can update the Mattermost approval thread
 * (accepted → delivered / ⚠ bounced / 🚫 complaint).
 *
 * Auth is the Svix HMAC signature (NOT CF Access) — the route is exempted from
 * the Access JWT middleware in app.ts and must also be bypassed at the edge
 * Access policy. Verification uses Web Crypto so no `svix`/`resend` dependency
 * is pulled into the Worker bundle.
 *
 * See: https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests
 */

import type { Context } from "hono";
import type { Env } from "../types";
import { notifyBridge } from "./webhook";

type DeliveryStatus = "delivered" | "bounced" | "complained" | "delayed";

const EVENT_STATUS: Record<string, DeliveryStatus> = {
	"email.delivered": "delivered",
	"email.bounced": "bounced",
	"email.complained": "complained",
	"email.delivery_delayed": "delayed",
};

interface ResendEvent {
	type?: string;
	created_at?: string;
	data?: {
		email_id?: string;
		to?: string[] | string;
		subject?: string;
		bounce?: { type?: string; subType?: string; message?: string };
	};
}

interface DeliveryMapEntry {
	mailboxId: string;
	emailId: string;
	threadId: string;
}

/** Constant-time-ish string compare (avoids early-exit length leak). */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

function bytesToBase64(bytes: ArrayBuffer): string {
	const arr = new Uint8Array(bytes);
	let bin = "";
	for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]!);
	return btoa(bin);
}

/**
 * Verify a Svix webhook signature (the scheme Resend uses).
 *
 * Signed content is `${id}.${timestamp}.${body}`; the secret is the base64
 * payload after the `whsec_` prefix; the `svix-signature` header is a
 * space-separated list of `v1,<base64>` candidates (any match passes).
 */
export async function verifySvixSignature(
	secret: string,
	id: string,
	timestamp: string,
	body: string,
	signatureHeader: string,
): Promise<boolean> {
	const rawSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
	let keyBytes: Uint8Array;
	try {
		keyBytes = base64ToBytes(rawSecret);
	} catch {
		return false;
	}
	const key = await crypto.subtle.importKey(
		"raw",
		keyBytes as BufferSource,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signed = `${id}.${timestamp}.${body}`;
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(signed) as BufferSource,
	);
	const expected = bytesToBase64(mac);

	return signatureHeader
		.split(" ")
		.filter((part) => part.startsWith("v1,"))
		.map((part) => part.slice(3))
		.some((candidate) => !!candidate && safeEqual(candidate, expected));
}

/**
 * Hono handler for POST /webhooks/resend. Returns 2xx for accepted-and-
 * processed or intentionally-ignored events so Resend does not retry; returns
 * 4xx for missing/invalid signatures or stale timestamps; returns 503 when the
 * secret is not configured (operator error — Resend should not retry either).
 */
export async function handleResendWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
	const secret = c.env.RESEND_WEBHOOK_SECRET;
	if (!secret) {
		console.error("Resend webhook received but RESEND_WEBHOOK_SECRET is unset");
		return c.json({ error: "Webhook not configured" }, 503);
	}

	const svixId = c.req.header("svix-id");
	const svixTimestamp = c.req.header("svix-timestamp");
	const svixSignature = c.req.header("svix-signature");
	if (!svixId || !svixTimestamp || !svixSignature) {
		return c.json({ error: "Missing Svix headers" }, 400);
	}

	// Reject stale webhooks (±5 min) to prevent signature replay attacks.
	const tsNum = parseInt(svixTimestamp, 10);
	if (isNaN(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) {
		return c.json({ error: "Webhook timestamp out of tolerance" }, 400);
	}

	const body = await c.req.text();
	const valid = await verifySvixSignature(secret, svixId, svixTimestamp, body, svixSignature);
	if (!valid) {
		return c.json({ error: "Invalid signature" }, 401);
	}

	let event: ResendEvent;
	try {
		event = JSON.parse(body) as ResendEvent;
	} catch {
		return c.json({ error: "Invalid JSON" }, 400);
	}

	const status = event.type ? EVENT_STATUS[event.type] : undefined;
	const resendId = event.data?.email_id;
	if (!status || !resendId) {
		// Not a delivery-lifecycle event we track (e.g. email.sent/opened) — ack.
		return c.json({ ok: true, ignored: event.type ?? "unknown" }, 200);
	}

	if (!c.env.DELIVERY_MAP) {
		console.error("Resend webhook: DELIVERY_MAP KV not bound");
		return c.json({ ok: true, ignored: "no-kv" }, 200);
	}

	const raw = await c.env.DELIVERY_MAP.get(resendId);
	if (!raw) {
		// No correlation (non-bridge send, expired, or CF fallback) — ack, no-op.
		return c.json({ ok: true, ignored: "no-correlation" }, 200);
	}

	let entry: DeliveryMapEntry;
	try {
		entry = JSON.parse(raw) as DeliveryMapEntry;
	} catch {
		return c.json({ ok: true, ignored: "bad-correlation" }, 200);
	}

	const reason =
		status === "bounced"
			? event.data?.bounce?.message || event.data?.bounce?.subType || event.data?.bounce?.type
			: undefined;

	c.executionCtx.waitUntil(
		notifyBridge(c.env, {
			event: "email-delivery-status",
			mailboxId: entry.mailboxId,
			emailId: entry.emailId,
			threadId: entry.threadId,
			status,
			...(reason ? { reason } : {}),
			timestamp: event.created_at || new Date().toISOString(),
		}),
	);

	return c.json({ ok: true, status }, 200);
}
