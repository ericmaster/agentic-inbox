# AGENTS.md — agentic-inbox (Nimblersoft fork)

Working context for any agent operating on this project. Company-wide context lives in
`~/nimbler-ops/AGENTS.md` (canonical project inventory) and `~/nimbler-ops/CONTEXT.md` (glossary).

## What this is

Self-hosted email for AI agents, replacing OpenMail. Fork of
[`cloudflare/agentic-inbox`](https://github.com/cloudflare/agentic-inbox) running on Cloudflare
Workers + Durable Objects (SQLite per mailbox) + R2 (attachments) + Email Routing + Email Service.
Deployed on the dedicated domain **`nimblerbot.com`** — web UI at `https://ainbox.nimblerbot.com`
(behind Access), mailboxes at `*@nimblerbot.com`. (The earlier `ai.nimblersoft.com` target was
abandoned — see PLAN.md; leftover CF resources await decommission.)

- **Repo:** `ericmaster/agentic-inbox`, branch `feat/nimblersoft-multidomain-bridge`.
- **Upstream base:** clean fork (last upstream commit `48039bb`, Merge PR #7).
- **Migration plan:** see [`PLAN.md`](PLAN.md). Glossary in [`CONTEXT.md`](CONTEXT.md).

## Fork modifications (2 commits on top of upstream)

### Commit 1 — `fb65cc0` multi-domain support (backport of upstream PR #49)
- `parseDomains()` helper in `workers/index.ts`; `/api/v1/config` uses it.
- Mailbox creation guard: when `DOMAINS` is set, a new mailbox's domain must be one of them
  (explicit `EMAIL_ADDRESSES` entries bypass the check). One instance serves
  `ai.nimblersoft.com` + others via comma-separated `DOMAINS`.
- Docs: `README.md`, `package.json`, `wrangler.jsonc` comments.

### Commit 2 — `47ef682` bridge integration + disable built-in AI
- **`workers/lib/webhook.ts`** — `notifyBridge(env, payload)`: fire-and-forget POST to the
  bridge with `X-Webhook-Secret`. **No-ops when `WEBHOOK_URL` is unset** → vanilla upstream
  behaviour is preserved; errors are logged, never thrown.
- **`receiveEmail()`** — the built-in Workers AI auto-draft trigger (`EMAIL_AGENT.fetch`) is
  **removed**. Hermes is the sole draft generator. Instead we fire a reference-only
  `email-received` webhook; the bridge fetches the full body via the API.
- **`POST /api/v1/mailboxes/:id/emails`** — added `?sync=true`:
  - `sync=true` (bridge approve path): `await sendEmail`, return `200 {status:"sent"}`,
    `502` on delivery failure. **No** `email-sent` webhook — the caller already has the result.
  - default (web UI): `waitUntil(sendEmail → email-sent webhook)`, return `202`.
- `workers/types.ts` — optional `WEBHOOK_URL?` / `WEBHOOK_SECRET?` on `Env`.

> **Deliberate deviation from PLAN.md's fork table:** the plan listed the `email-sent` webhook as
> firing "after successful sync send". It fires on the **async (web-UI) path only**. Firing it on
> the bridge's own sync send would echo the bridge's sends back to it and break dedup.

### Webhook payload contracts
See PLAN.md → "Webhook Payload Contract". `email-received` is reference-only (bridge fetches the
body via `GET /api/v1/mailboxes/:mailboxId/emails/:emailId`). `email-sent` carries `source:"web-ui"`.

## Config & secrets

Same pattern as upstream's `POLICY_AUD`/`TEAM_DOMAIN` (declared in `types.ts`, set in prod — NOT
committed to `wrangler.jsonc`):

| Key | Where | Notes |
|---|---|---|
| `DOMAINS` | `wrangler.jsonc` var | `nimblerbot.com` (Phase 1 live). `ericmaster.ninja` + `meliruns.com` are live on Zoho — deferred to PLAN Phase 4. |
| `EMAIL_ADDRESSES` | `wrangler.jsonc` var | optional allow-list of creatable mailbox addresses. |
| `POLICY_AUD`, `TEAM_DOMAIN` | secret/var (Infisical) | Cloudflare Access. |
| `WEBHOOK_URL` | var (Infisical) | `https://mail-bridge.nimblersoft.com/webhooks/agentic-inbox`. |
| `WEBHOOK_SECRET` | **Worker secret** | `wrangler secret put WEBHOOK_SECRET`. Shared with the bridge. |

Infisical project: **Agentic Inbox** (`6c293d88-cc3c-4a44-8368-faa22c8c0196`). `.dev.vars.example`
documents local-dev values. Never commit real secrets.

## Commands

```bash
npm install
npm run typecheck   # wrangler types + tsc --noEmit
npm run build       # react-router + vite build
npm run dev         # local dev server (needs .dev.vars)
npm run deploy      # wrangler deploy — DO NOT run unsupervised (live infra)
```

## Known issues / watch-outs

- **Live infra steps are human-gated.** Deploy, DNS/MX cutover, Email Routing, Email Service
  verification, and Infisical secret writes are NOT done autonomously. See PLAN.md Phase 1.
- Inbound runs on the dedicated zone `nimblerbot.com` (mail at the apex). The shared
  `ai.nimblersoft.com`/Google zone was abandoned — CF refuses Email Routing while the apex has
  non-Cloudflare (Google) MX. See PLAN.md.
- **Do not** enable Email Routing/catch-all on `ericmaster.ninja` or `meliruns.com` before PLAN
  Phase 4 — both are live on Zoho and would have their inbound hijacked.
- `nimblersoft.com` MX (Google Workspace) must never be touched.
- The bridge itself (`~/agentic/agentic-inbox-bridge/`) is built in PLAN Phase 2; this repo only
  emits webhooks to it.
- Generated `worker-configuration.d.ts` and `build/` are gitignored.

## Live deployment status (2026-06-17 — Phase 1 COMPLETE on `nimblerbot.com`)

**Live & validated** on the dedicated domain **`nimblerbot.com`** (its own CF zone, account
`71f942c5…` — the **same** account as the Worker, required for custom domain / routing-to-Worker /
Email Sending):
- Worker `agentic-inbox` (`DOMAINS=nimblerbot.com`); R2 `agentic-inbox`; DOs MAILBOX/EMAIL_AGENT/EMAIL_MCP; AI; EMAIL send.
- **Access** app `Agentic Inbox (nimblerbot.com)` → `ainbox.nimblerbot.com` (`id=efb1a4c3…`, `POLICY_AUD=814e4b55…`, team `nimblersoft.cloudflareaccess.com`); service token `agentic-inbox-bridge` (`658c03a3…`) in its policy. Service-token API → 200 confirmed.
- **Custom domain** `ainbox.nimblerbot.com` (proxied AAAA) — apex reserved for mail only.
- **Email Routing** on the apex; **literal** rules `sofia.luz@`/`silas.vertiz@ → Worker`; catch-all disabled (drop).
- **Email Sending** onboarded. Apex DNS (12 recs): 3× MX `route*.mx.cloudflare.net`, single SPF `v=spf1 include:_spf.mx.cloudflare.net ~all`, `_dmarc p=reject`, DKIM `cf2024-1` + `cf-bounce.*` (MX/SPF/DKIM).
- **Mailboxes:** `sofia.luz@nimblerbot.com`, `silas.vertiz@nimblerbot.com` (`mailboxId = lowercase address`).
- **Secrets** (Worker + Infisical **Agentic Inbox/prod**): `POLICY_AUD` (now `814e4b55…`), `TEAM_DOMAIN`, `WEBHOOK_URL`, `WEBHOOK_SECRET`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`.
- **Validated:** internal `sofia→silas`; external out `sofia→eric@nimblersoft.com` (landed in **inbox**, passes `p=reject`); external in `eric→sofia` (stored); global NS/MX/SPF/DKIM/DMARC propagation confirmed.

**Abandoned — shared `ai.nimblersoft.com` zone:** CF refuses Email Routing while the `nimblersoft.com`
apex has Google MX (*"Existing non-Cloudflare MX records conflict…"*). The `ai.nimblersoft.com` Access
app (`142c5fd6…`) / custom domain / Email Sending onboarding are **moot and await decommission**.
`nimblersoft.com` (Google) and the Zoho domains were never touched.

**Gotchas learned:** (1) `@cloudflare/vite-plugin` strips `routes` from the generated deploy config →
custom domains via the Workers Domains API (wrangler OAuth token), not `wrangler.jsonc`. (2) Enabling
Email Routing / onboarding Email Sending is **not** an API-token permission (only "Email Routing Rules"
is) — done in the dashboard. (3) Zone + Worker must share a CF account. (4) `mailboxId = lowercase
email address`. (5) Scoped `CLOUDFLARE_EMAIL_API_TOKEN` in Infisical **Nimblerbox/dev** (DNS + Email
Routing Rules + Email Sending + Email Routing Addresses : Edit) manages rules; the wrangler OAuth token
+ broad `CLOUDFLARE_API_TOKEN` lack email-write scopes.
