// Standalone test for the outbound provider dispatch + Cloudflare fallback.
// Run: node_modules/.bin/tsx workers/email-sender.test.ts
// No test framework in this repo — uses node:assert and a hand-rolled runner so
// it stays dependency-free.

import assert from "node:assert";
import { sendEmail, type SendEmailParams } from "./email-sender";

const PARAMS: SendEmailParams = {
	to: "dest@example.com",
	from: { name: "Sofia Luz", email: "sofia.luz@nimblerbot.com" },
	subject: "Re: hello",
	html: "<p>hi</p>",
	text: "hi",
	headers: { "In-Reply-To": "<abc@x>" },
	attachments: [
		{ content: "AAAA", filename: "a.pdf", type: "application/pdf", disposition: "attachment" },
	],
};

const realFetch = globalThis.fetch;
function mockFetch(impl: (url: string, init: any) => Response) {
	(globalThis as any).fetch = async (url: string, init: any) => impl(url, init);
}
function restoreFetch() {
	(globalThis as any).fetch = realFetch;
}

// A fake Cloudflare EMAIL binding that records whether it was called.
function fakeBinding() {
	const state = { called: false, lastMessage: null as any };
	const binding = {
		send: async (message: any) => {
			state.called = true;
			state.lastMessage = message;
			return { messageId: "cf-msg-1" };
		},
	};
	return { binding, state };
}

function envFor(overrides: Record<string, unknown>, binding: any) {
	return { EMAIL: binding, ...overrides } as any;
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
	try {
		await fn();
		console.log(`  ✓ ${name}`);
		passed++;
	} catch (e) {
		console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
		process.exitCode = 1;
	}
}

async function main() {
	console.log("email-sender dispatch + fallback");

	await test("default provider uses Cloudflare, never calls Resend", async () => {
		const { binding, state } = fakeBinding();
		let resendCalls = 0;
		mockFetch(() => {
			resendCalls++;
			return new Response("{}", { status: 200 });
		});
		const res = await sendEmail(envFor({}, binding), PARAMS);
		restoreFetch();
		assert.equal(res.providerUsed, "cloudflare");
		assert.equal(res.fallback, undefined, "primary Cloudflare is not a fallback");
		assert.equal(state.called, true);
		assert.equal(resendCalls, 0);
	});

	await test("resend success: posts correct payload, returns providerId", async () => {
		const { binding, state } = fakeBinding();
		let captured: any = null;
		mockFetch((url, init) => {
			assert.equal(url, "https://api.resend.com/emails");
			assert.equal(init.headers.Authorization, "Bearer re_test");
			captured = JSON.parse(init.body);
			return new Response(JSON.stringify({ id: "re_abc123" }), { status: 200 });
		});
		const res = await sendEmail(
			envFor({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test" }, binding),
			PARAMS,
		);
		restoreFetch();
		assert.equal(res.providerUsed, "resend");
		assert.equal(res.providerId, "re_abc123");
		assert.equal(res.messageId, "re_abc123");
		assert.equal(state.called, false, "Cloudflare must not be called on success");
		// payload mapping
		assert.equal(captured.from, "Sofia Luz <sofia.luz@nimblerbot.com>");
		assert.equal(captured.to, "dest@example.com");
		assert.deepEqual(captured.headers, { "In-Reply-To": "<abc@x>" });
		assert.equal(captured.attachments[0].content_type, "application/pdf");
		assert.equal(captured.attachments[0].filename, "a.pdf");
	});

	await test("resend 429 (cap) with fallback=true → Cloudflare, providerUsed=cloudflare", async () => {
		const { binding, state } = fakeBinding();
		mockFetch(() =>
			new Response(JSON.stringify({ name: "rate_limit_exceeded", message: "Too many" }), {
				status: 429,
			}),
		);
		const res = await sendEmail(
			envFor(
				{ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test", EMAIL_FALLBACK_CLOUDFLARE: "true" },
				binding,
			),
			PARAMS,
		);
		restoreFetch();
		assert.equal(res.providerUsed, "cloudflare");
		assert.equal(res.providerId, undefined);
		assert.equal(res.fallback, true, "fallback flag must be set");
		assert.equal(state.called, true, "Cloudflare fallback must fire");
	});

	await test("resend 5xx with fallback=true → Cloudflare", async () => {
		const { binding, state } = fakeBinding();
		mockFetch(() => new Response("{}", { status: 503 }));
		const res = await sendEmail(
			envFor(
				{ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test", EMAIL_FALLBACK_CLOUDFLARE: "true" },
				binding,
			),
			PARAMS,
		);
		restoreFetch();
		assert.equal(res.providerUsed, "cloudflare");
		assert.equal(state.called, true);
	});

	await test("resend 429 with fallback disabled → throws, Cloudflare untouched", async () => {
		const { binding, state } = fakeBinding();
		mockFetch(() => new Response(JSON.stringify({ message: "capped" }), { status: 429 }));
		await assert.rejects(
			sendEmail(
				envFor({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test" }, binding),
				PARAMS,
			),
		);
		restoreFetch();
		assert.equal(state.called, false);
	});

	await test("resend 422 (validation) with fallback=true → throws (NOT fallback-eligible)", async () => {
		const { binding, state } = fakeBinding();
		mockFetch(() => new Response(JSON.stringify({ message: "bad from" }), { status: 422 }));
		await assert.rejects(
			sendEmail(
				envFor(
					{ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test", EMAIL_FALLBACK_CLOUDFLARE: "true" },
					binding,
				),
				PARAMS,
			),
		);
		restoreFetch();
		assert.equal(state.called, false, "hard 4xx must not mask via CF retry");
	});

	await test("resend network throw with fallback=true → Cloudflare", async () => {
		const { binding, state } = fakeBinding();
		mockFetch(() => {
			throw new Error("ECONNRESET");
		});
		const res = await sendEmail(
			envFor(
				{ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test", EMAIL_FALLBACK_CLOUDFLARE: "true" },
				binding,
			),
			PARAMS,
		);
		restoreFetch();
		assert.equal(res.providerUsed, "cloudflare");
		assert.equal(state.called, true);
	});

	await test("per-domain: mapped from-domain uses its own Resend key", async () => {
		const { binding } = fakeBinding();
		let auth = "";
		mockFetch((_url, init) => {
			auth = init.headers.Authorization;
			return new Response(JSON.stringify({ id: "re_ninja" }), { status: 200 });
		});
		const res = await sendEmail(
			envFor(
				{
					EMAIL_PROVIDER: "resend",
					RESEND_API_KEY: "re_default",
					RESEND_DOMAIN_KEYS: '{"ericmaster.ninja":"RESEND_ERICMASTER_NINJA"}',
					RESEND_ERICMASTER_NINJA_API_KEY: "re_ninja_key",
				},
				binding,
			),
			{ ...PARAMS, from: { name: "Eric", email: "me@ericmaster.ninja" } },
		);
		restoreFetch();
		assert.equal(res.providerUsed, "resend");
		assert.equal(auth, "Bearer re_ninja_key", "must use the per-domain key, not the default");
	});

	await test("per-domain: unmapped from-domain falls back to RESEND_API_KEY", async () => {
		const { binding } = fakeBinding();
		let auth = "";
		mockFetch((_url, init) => {
			auth = init.headers.Authorization;
			return new Response(JSON.stringify({ id: "re_def" }), { status: 200 });
		});
		await sendEmail(
			envFor(
				{
					EMAIL_PROVIDER: "resend",
					RESEND_API_KEY: "re_default",
					RESEND_DOMAIN_KEYS: '{"ericmaster.ninja":"RESEND_ERICMASTER_NINJA"}',
					RESEND_ERICMASTER_NINJA_API_KEY: "re_ninja_key",
				},
				binding,
			),
			PARAMS, // from sofia.luz@nimblerbot.com — not mapped
		);
		restoreFetch();
		assert.equal(auth, "Bearer re_default", "unmapped domain uses the default account");
	});

	await test("provider=resend but no API key → throws", async () => {
		const { binding } = fakeBinding();
		await assert.rejects(
			sendEmail(envFor({ EMAIL_PROVIDER: "resend" }, binding), PARAMS),
			/RESEND_API_KEY/,
		);
		restoreFetch();
	});

	console.log(`\n${passed} passed`);
}

main();
