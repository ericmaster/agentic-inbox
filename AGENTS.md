# AGENTS.md — agentic-inbox (Nimblersoft fork)

Working context for any agent operating on this project. Company-wide context lives in
`~/nimbler-ops/AGENTS.md` (canonical project inventory) and `~/nimbler-ops/CONTEXT.md` (glossary).

## What this is

Self-hosted email for AI agents, replacing OpenMail. Fork of
[`cloudflare/agentic-inbox`](https://github.com/cloudflare/agentic-inbox) running on Cloudflare
Workers + Durable Objects (SQLite per mailbox) + R2 (attachments) + Email Routing + Email Service.
Deployed at `https://ai.nimblersoft.com`.

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
| `DOMAINS` | `wrangler.jsonc` var | `ai.nimblersoft.com,ericmaster.ninja,meliruns.com` — but only `ai.nimblersoft.com` is cut over in Phase 1 (the other two are live on Zoho; deferred to PLAN Phase 4). |
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
- `ai.nimblersoft.com` is a **single-MX hard cutover** (currently Mailgun/OpenMail). Validate on a
  test address before flipping; rollback = repoint MX to Mailgun.
- **Do not** enable Email Routing/catch-all on `ericmaster.ninja` or `meliruns.com` before PLAN
  Phase 4 — both are live on Zoho and would have their inbound hijacked.
- `nimblersoft.com` MX (Google Workspace) must never be touched.
- The bridge itself (`~/agentic/agentic-inbox-bridge/`) is built in PLAN Phase 2; this repo only
  emits webhooks to it.
- Generated `worker-configuration.d.ts` and `build/` are gitignored.

## Live deployment status (2026-06-16, Phase 1 supervised)

**Deployed & live:** Worker `agentic-inbox` (bindings provisioned), R2 `agentic-inbox`, Access app
`Agentic Inbox`→`ai.nimblersoft.com` (`POLICY_AUD=6189a26a…`, team `nimblersoft.cloudflareaccess.com`),
service token `agentic-inbox-bridge`, custom domain `ai.nimblersoft.com` (proxied AAAA, web UI behind
Access — 302→Access confirmed), Email **Sending** onboarded (`cf-bounce.*` DKIM/SPF/DMARC; no SPF
collision). Secrets in Infisical **Agentic Inbox/prod**: `POLICY_AUD`, `TEAM_DOMAIN`, `WEBHOOK_URL`,
`WEBHOOK_SECRET`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`.

**Blocked:** inbound **Email Routing** (PLAN 1.9). `ai.nimblersoft.com` is a subdomain inside the
`nimblersoft.com` (Google) zone; the Email Routing enable wizard is zone-level and forces apex MX +
a duplicate apex SPF → would endanger Google Workspace. Stopped per guardrail. See PLAN.md "Execution
Notes — Live Infra" for the resolution options (preferred: make `ai.nimblersoft.com` its own CF zone).

**Gotchas learned:** (1) `@cloudflare/vite-plugin` strips `routes` from the generated deploy config →
custom domains are managed via the Workers Domains API, not `wrangler.jsonc`. (2) Enabling Email
Routing is **not** an API-token permission (only "Email Routing Rules" is) — it needs the dashboard or
the `email_routing:write` OAuth scope. (3) Scoped `CLOUDFLARE_EMAIL_API_TOKEN` lives in Infisical
**Nimblerbox/dev** (DNS + Email Routing Rules + Email Sending + Email Routing Addresses : Edit).
