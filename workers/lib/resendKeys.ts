// Copyright (c) 2026 Nimblersoft.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-domain Resend account resolution.
 *
 * This instance serves several sending domains (`DOMAINS`), and each domain may
 * live in its OWN Resend account (separate API key + webhook signing secret).
 * The default account (`RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET`) serves any
 * domain not explicitly mapped.
 *
 * The mapping is the `RESEND_DOMAIN_KEYS` var — a JSON object of
 * `{ "<sending-domain>": "<SECRET_PREFIX>" }`. For each mapped domain the Worker
 * reads `<SECRET_PREFIX>_API_KEY` (send) and `<SECRET_PREFIX>_WEBHOOK_SECRET`
 * (delivery-webhook verification) from the environment. Example:
 *
 *   RESEND_DOMAIN_KEYS = {"ericmaster.ninja":"RESEND_ERICMASTER_NINJA",
 *                         "meliruns.com":"RESEND_MELIRUNS"}
 *
 * resolves `eric@ericmaster.ninja` sends to `RESEND_ERICMASTER_NINJA_API_KEY`.
 *
 * An explicit map (rather than a mechanical `domain → SCREAMING_SNAKE` rule) is
 * deliberate: the secret prefixes are NOT derivable from the domain in general
 * (e.g. `ericmaster.ninja → …_NINJA` keeps the TLD, `meliruns.com → MELIRUNS`
 * drops it), so the operator declares the prefix per domain.
 */

import type { Env } from "../types";

/** Env carries dynamically-named per-domain Resend secrets (`<PREFIX>_API_KEY`,
 *  `<PREFIX>_WEBHOOK_SECRET`) that are not on the static `Env` interface. */
type DynamicEnv = Record<string, string | undefined>;

/** Lowercased domain part of an email address or display-name string. Returns
 *  "" when no `@domain` can be extracted. */
export function domainFromAddress(
	addr: string | { email: string; name: string },
): string {
	const email = typeof addr === "string" ? addr : addr.email;
	const at = email.lastIndexOf("@");
	if (at === -1) return "";
	// Strip a trailing ">" from "Name <a@b.com>" style strings.
	return email
		.slice(at + 1)
		.replace(/[>\s]+$/, "")
		.trim()
		.toLowerCase();
}

/** Parse `RESEND_DOMAIN_KEYS` into a domain→prefix map. Malformed/empty → {}. */
export function parseResendDomainKeys(env: Env): Record<string, string> {
	const raw = (env as unknown as DynamicEnv).RESEND_DOMAIN_KEYS;
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") return {};
		const out: Record<string, string> = {};
		for (const [domain, prefix] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof prefix === "string" && prefix) out[domain.toLowerCase()] = prefix;
		}
		return out;
	} catch {
		console.error("RESEND_DOMAIN_KEYS is not valid JSON — using default Resend account only");
		return {};
	}
}

/**
 * Resolve the Resend API key for a given `from` address. Returns the mapped
 * domain's `<PREFIX>_API_KEY` when configured, otherwise the default
 * `RESEND_API_KEY`. Returns `undefined` when neither is set (caller errors).
 */
export function resolveResendApiKey(
	env: Env,
	from: string | { email: string; name: string },
): string | undefined {
	const domain = domainFromAddress(from);
	const prefix = parseResendDomainKeys(env)[domain];
	if (prefix) {
		const key = (env as unknown as DynamicEnv)[`${prefix}_API_KEY`];
		if (key) return key;
		console.error(
			`RESEND_DOMAIN_KEYS maps ${domain} → ${prefix} but ${prefix}_API_KEY is unset; falling back to RESEND_API_KEY`,
		);
	}
	return env.RESEND_API_KEY;
}

/**
 * Every configured Resend webhook signing secret (default + all per-domain).
 * The delivery webhook is verified against ALL of them (any match passes):
 * the Svix payload carries no domain, and the `DELIVERY_MAP` correlation is
 * account-agnostic, so one webhook URL can serve every Resend account.
 */
export function resendWebhookSecrets(env: Env): string[] {
	const secrets: string[] = [];
	if (env.RESEND_WEBHOOK_SECRET) secrets.push(env.RESEND_WEBHOOK_SECRET);
	for (const prefix of Object.values(parseResendDomainKeys(env))) {
		const s = (env as unknown as DynamicEnv)[`${prefix}_WEBHOOK_SECRET`];
		if (s) secrets.push(s);
	}
	return secrets;
}
