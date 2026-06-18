// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Outbound email sending with a pluggable provider.
 *
 * Selected via `EMAIL_PROVIDER` ("cloudflare" | "resend"; default "cloudflare"):
 *  - "cloudflare": the `send_email` Worker binding (`env.EMAIL.send()`).
 *  - "resend":     the Resend HTTP API (https://api.resend.com/emails).
 *
 * When the provider is "resend" and a send fails with a transient/cap error
 * (429 daily-cap or rate-limit, 5xx, or a network throw), the dispatcher falls
 * back to Cloudflare if `EMAIL_FALLBACK_CLOUDFLARE === "true"`. A fallback send
 * has NO delivery telemetry (Cloudflare emits no bounce webhook) and re-exposes
 * the original deliverability risk, so callers surface `providerUsed` to the
 * human approver. This is a last-resort to avoid total send failure, not a
 * co-equal path.
 *
 * See:
 *  - https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 *  - https://resend.com/docs/api-reference/emails/send-email
 */

import type { Env } from "./types";
import { resolveResendApiKey } from "./lib/resendKeys";

export interface SendEmailParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: {
		content: string; // base64 encoded
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
	headers?: Record<string, string>;
}

export interface SendEmailResult {
	/** Provider-side message id. For Resend this is the `re_…` id used for
	 *  webhook delivery correlation; for Cloudflare it is the binding's id. */
	messageId: string;
	/** Resend's `id` (`re_…`). Present only when the send actually went via
	 *  Resend — used to correlate delivery/bounce webhooks. */
	providerId?: string;
	/** Which provider actually delivered the message (after any fallback). */
	providerUsed: "resend" | "cloudflare";
	/** True only when Resend was the configured provider but the send fell back
	 *  to Cloudflare. Distinguishes "Cloudflare as primary" (normal) from
	 *  "Cloudflare as last-resort fallback" (degraded, no delivery telemetry). */
	fallback?: boolean;
}

/** Error thrown by the Resend path, annotated with the HTTP status (if any)
 *  so the dispatcher can decide whether the failure is fallback-eligible. */
class ResendSendError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "ResendSendError";
	}
}

function formatAddress(addr: string | { email: string; name: string }): string {
	return typeof addr === "string" ? addr : `${addr.name} <${addr.email}>`;
}

/**
 * Send via the Cloudflare Email Service binding (`env.EMAIL.send()`).
 */
async function sendViaCloudflare(
	binding: SendEmail,
	params: SendEmailParams,
): Promise<{ messageId: string }> {
	const message: Record<string, unknown> = {
		to: params.to,
		from: params.from,
		subject: params.subject,
	};

	if (params.html) message.html = params.html;
	if (params.text) message.text = params.text;
	if (params.cc) message.cc = params.cc;
	if (params.bcc) message.bcc = params.bcc;
	if (params.replyTo) message.replyTo = params.replyTo;

	if (params.headers && Object.keys(params.headers).length > 0) {
		message.headers = params.headers;
	}

	if (params.attachments && params.attachments.length > 0) {
		message.attachments = params.attachments.map((att) => ({
			content: att.content,
			filename: att.filename,
			type: att.type,
			disposition: att.disposition,
			...(att.contentId ? { contentId: att.contentId } : {}),
		}));
	}

	const result = await binding.send(message as any);
	return { messageId: result.messageId };
}

/**
 * Send via the Resend HTTP API. Returns Resend's `id` as the messageId.
 * Throws {@link ResendSendError} (with `.status`) on any non-2xx response.
 */
async function sendViaResend(
	apiKey: string,
	params: SendEmailParams,
): Promise<{ messageId: string }> {
	// Resend uses snake_case (`reply_to`, `content_type`) and expects `from` as
	// a display-name string. `to`/`cc`/`bcc` accept a string or string[].
	const payload: Record<string, unknown> = {
		from: formatAddress(params.from),
		to: params.to,
		subject: params.subject,
	};

	if (params.html) payload.html = params.html;
	if (params.text) payload.text = params.text;
	if (params.cc) payload.cc = params.cc;
	if (params.bcc) payload.bcc = params.bcc;
	if (params.replyTo) payload.reply_to = formatAddress(params.replyTo);
	if (params.headers && Object.keys(params.headers).length > 0) {
		payload.headers = params.headers;
	}
	if (params.attachments && params.attachments.length > 0) {
		payload.attachments = params.attachments.map((att) => ({
			content: att.content, // base64
			filename: att.filename,
			content_type: att.type,
			...(att.contentId ? { content_id: att.contentId } : {}),
		}));
	}

	let res: Response;
	try {
		res = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});
	} catch (e) {
		// Network-level failure — no status, treated as fallback-eligible.
		throw new ResendSendError(`Resend request failed: ${(e as Error).message}`);
	}

	const data = (await res.json().catch(() => ({}))) as {
		id?: string;
		message?: string;
		name?: string;
	};

	if (!res.ok || !data.id) {
		const detail = data.message || data.name || `HTTP ${res.status}`;
		throw new ResendSendError(`Resend send failed: ${detail}`, res.status);
	}

	return { messageId: data.id };
}

/** A Resend failure is fallback-eligible if it is a daily-cap / rate-limit
 *  (429), a server error (5xx), or a network throw (no status). Hard 4xx
 *  (e.g. 422 validation) are caller bugs — surfaced, not masked by a CF retry. */
function isFallbackEligible(e: unknown): boolean {
	if (!(e instanceof ResendSendError)) return true; // unexpected throw — try CF
	return e.status === undefined || e.status === 429 || e.status >= 500;
}

/**
 * Send an email using the configured provider, with optional Cloudflare fallback.
 *
 * @param env    - Worker env (provider flag, Resend key, EMAIL binding)
 * @param params - Email parameters (to, from, subject, body, etc.)
 * @returns messageId, optional Resend providerId, and which provider was used
 * @throws On delivery errors when no fallback applies
 */
export async function sendEmail(
	env: Env,
	params: SendEmailParams,
): Promise<SendEmailResult> {
	const provider = env.EMAIL_PROVIDER ?? "cloudflare";

	if (provider === "resend") {
		// Resolve the Resend account by sending domain — each domain may live in
		// its own account (see lib/resendKeys.ts). Falls back to RESEND_API_KEY.
		const apiKey = resolveResendApiKey(env, params.from);
		if (!apiKey) {
			throw new Error(
				"EMAIL_PROVIDER=resend but no Resend API key is configured for " +
					`'${typeof params.from === "string" ? params.from : params.from.email}' ` +
					"(no per-domain RESEND_DOMAIN_KEYS match and RESEND_API_KEY is unset)",
			);
		}
		try {
			const { messageId } = await sendViaResend(apiKey, params);
			return { messageId, providerId: messageId, providerUsed: "resend" };
		} catch (e) {
			const canFallback =
				env.EMAIL_FALLBACK_CLOUDFLARE === "true" && isFallbackEligible(e);
			if (!canFallback) throw e;
			console.error(
				`Resend send failed (${(e as Error).message}); falling back to Cloudflare`,
			);
			const { messageId } = await sendViaCloudflare(env.EMAIL, params);
			return { messageId, providerUsed: "cloudflare", fallback: true };
		}
	}

	const { messageId } = await sendViaCloudflare(env.EMAIL, params);
	return { messageId, providerUsed: "cloudflare" };
}
