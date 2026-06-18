// Standalone test for Svix signature verification (the scheme Resend uses).
// Run: node_modules/.bin/tsx workers/lib/resendWebhook.test.ts

import assert from "node:assert";
import { verifySvixSignature } from "./resendWebhook";

// Build a valid Svix signature the same way the verifier expects, using the
// global Web Crypto available in Node 22 — independent of the verifier code.
async function sign(secretB64: string, id: string, ts: string, body: string): Promise<string> {
	const keyBytes = Uint8Array.from(atob(secretB64), (ch) => ch.charCodeAt(0));
	const key = await crypto.subtle.importKey(
		"raw",
		keyBytes,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`));
	return btoa(String.fromCharCode(...new Uint8Array(mac)));
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
	console.log("resend webhook Svix verification");

	const secretB64 = btoa("super-secret-key-material-1234567"); // raw base64 secret
	const secret = `whsec_${secretB64}`;
	const id = "msg_2abc";
	const ts = "1700000000";
	const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_1" } });

	await test("valid signature passes (whsec_ prefix stripped)", async () => {
		const sig = await sign(secretB64, id, ts, body);
		const ok = await verifySvixSignature(secret, id, ts, body, `v1,${sig}`);
		assert.equal(ok, true);
	});

	await test("multiple candidate signatures: any match passes", async () => {
		const sig = await sign(secretB64, id, ts, body);
		const ok = await verifySvixSignature(secret, id, ts, body, `v1,deadbeef v1,${sig}`);
		assert.equal(ok, true);
	});

	await test("tampered body fails", async () => {
		const sig = await sign(secretB64, id, ts, body);
		const ok = await verifySvixSignature(secret, id, ts, body + "x", `v1,${sig}`);
		assert.equal(ok, false);
	});

	await test("wrong secret fails", async () => {
		const sig = await sign(secretB64, id, ts, body);
		const otherSecret = `whsec_${btoa("a-different-secret-key-aaaaaaaaa")}`;
		const ok = await verifySvixSignature(otherSecret, id, ts, body, `v1,${sig}`);
		assert.equal(ok, false);
	});

	await test("mismatched timestamp fails (signed content differs)", async () => {
		const sig = await sign(secretB64, id, ts, body);
		const ok = await verifySvixSignature(secret, id, "1700009999", body, `v1,${sig}`);
		assert.equal(ok, false);
	});

	console.log(`\n${passed} passed`);
}

main();
