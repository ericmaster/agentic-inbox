# Implementation Plan: OpenMail → Agentic Inbox Migration

## Overview
Replace `openmail.sh` (SaaS email provider) with `agentic-inbox` self-hosted on Cloudflare Workers at `ai.nimblersoft.com`. Phase 1 cuts over `ai.nimblersoft.com` only; the additional domains (`ericmaster.ninja`, `meliruns.com`) are **live on Zoho** and their cutover is deferred to Phase 4 alongside the Zoho migration. `nimblersoft.com` stays on Google Workspace (MX records untouched, no forwarding). Preserve Hermes Mattermost notification + Hermes persona reply approval workflow. Decommission all OpenMail artifacts. Migrate select Zoho mail data (low priority, deferred).

## Current Context
- **Current provider:** OpenMail (`api.openmail.sh`) — WebSocket-based, CLI tool `@openmail/cli`
- **Existing accounts:** sofia.luz@ai.nimblersoft.com, silas.vertiz@ai.nimblersoft.com
- **Bridge:** `~/agentic/hermes-mail-mm-bridge/` — Node.js daemon (WS → MM REST → Hermes `/v1/responses`)
- **Bridge features:** per-agent routing, approval workflow (✅ reactions via polling), correction detection (10s poll), owner auto-send, CC cross-inbox routing, stateful `conversation:` threading via `/v1/responses`
- **Target:** `ericmaster/agentic-inbox` (fork of `cloudflare/agentic-inbox`, clean — 0 diff)
- **Target architecture:** Cloudflare Workers + Durable Objects (SQLite per mailbox) + R2 (attachments) + Email Routing + Workers AI agent
- **Multi-domain PR:** cloudflare/agentic-inbox#49 — not yet merged upstream. Patches ready to apply to fork.

## Architecture Change

### Current (OpenMail)
```
External Email → OpenMail Provider → WebSocket push → bridge.js (polls MM every 5s/10s)
  → Mattermost notification → Hermes /v1/responses → suggested reply
  → admin ✅ reaction → poll detects → bridge.js → OpenMail CLI send
```

### Target (Agentic Inbox)
```
External Email → CF Email Routing → Agentic Inbox Worker → Durable Object (inbox)
  → fire-and-forget webhook → POST to bridge (reference only, no body)
  → bridge fetches email via API → Mattermost notification
  → Hermes /v1/responses → suggested reply → posted as threaded reply
  → admin types "approve" in thread → MM outgoing webhook → bridge sends via API (?sync=true)
  → (parallel) web UI approval → Agentic Inbox sends → email-sent webhook → bridge dedup
  → corrections: any non-bot reply in thread → MM outgoing webhook → bridge revises via Hermes
```

## Decisions (Phase 0 — Grilling Session)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Inbox domain** | `ai.nimblersoft.com` (NOT nimblersoft.com) | nimblersoft.com MX → Google Workspace. Cannot move without breaking Gmail. |
| **nimblersoft.com email** | No change, no forwarding | Don't mix human Gmail mailboxes with AI agent mailboxes. |
| **MM notifications** | Keep | Know when agent receives email and prepares to send. |
| **Approval flow** | Exact-match "approve" reply + web UI | Zero polling. MM outgoing webhook delivers all channel posts to bridge. Bridge filters for "approve" (case-insensitive, trimmed, must be reply to known pending thread). Web UI approval coexists with dedup. |
| **Correction detection** | MM outgoing webhook (no trigger word) | Outgoing webhook fires on every post in channel. Bridge filters: non-bot reply to known root_post_id = correction. Zero polling. |
| **Hermes personas** | Keep — same integration path | Agent personas (Sofia/Silas) require context-aware replies via `/v1/responses`. |
| **AI strategy** | Hermes sole draft generator; disable Agentic Inbox built-in AI | Workers AI drafts are generic. Remove `agentStub.fetch()` auto-draft trigger in fork. |
| **Dual-approval dedup** | Agentic Inbox emits `email-sent` webhook | When web UI sends, Agentic Inbox fires webhook → bridge marks pending resolved → updates MM post with audit trail. |
| **Conversation keying** | `agentic-inbox-{mailbox_address}-{thread_id}` | Mailbox-scoped. Prevents cross-mailbox context bleed. |
| **CC routing** | Drop CC parsing (Scenario A) | Modern mail servers deliver separate copies to each recipient. Each inbox processes independently. |
| **Self-sent loop detection** | Keep same logic | If sender matches a configured mailbox address → notification only, no draft. |
| **Bridge deployment** | Docker + CF Tunnel at `mail-bridge.nimblersoft.com` | Same pattern as `hermes-mm-bridge` and `hermes-plane-bridge`. Defer CF Workers deployment until Hermes private access pattern is solved. |
| **Bridge tech stack** | Hono + TypeScript | Aligned with Agentic Inbox. Lightweight, type-safe. |
| **Bridge API auth** | CF Access Service Token | No code changes in Agentic Inbox. Access validates at edge, injects JWT. Bridge sends `CF-Access-Client-Id` + `CF-Access-Client-Secret` headers. |
| **Webhook auth** | Shared secrets | `X-Webhook-Secret` header validated against env vars for both Agentic Inbox and MM webhooks. Stored in Infisical. |
| **Webhook payload** | Reference only (no body) | Webhook sends `{ mailboxId, emailId, from, subject, threadId, ... }`. Bridge fetches full email via `GET /api/v1/mailboxes/:mailboxId/emails/:emailId`. |
| **Send API** | Use existing `POST /api/v1/mailboxes/:mailboxId/emails` | Already exists in upstream. Add `?sync=true` query param for synchronous mode (bridge). Default async for web UI. |
| **Email signatures** | Agentic Inbox per-mailbox settings | Signatures stored in Agentic Inbox settings, appended on send. Hermes system prompt: "No generes firma — se agrega automáticamente al enviar." |
| **Restart recovery** | Startup reconciliation | Bridge scans recent MM posts (last 24h) on boot, finds unprocessed "approve" replies. ~20 lines. |
| **MCP** | REST API for bridge; MCP available for other tools | MCP out of scope for this plan. |
| **Zoho migration** | Partial, low priority, deferred | Only specific recent emails. Defer as long as agentic-inbox receives new mail reliably. |

## Fork Modifications (`ericmaster/agentic-inbox`)

Two commits on the fork:

### Commit 1: Multi-domain support (PR #49 patches, ~44 lines)
- `workers/index.ts` — `parseDomains()` helper + backend guard
- `wrangler.jsonc` — multi-domain comments
- `README.md` — documentation
- `package.json` — deployment description update

### Commit 2: Bridge integration (~38 lines)
| File | Change | Lines |
|------|--------|-------|
| `workers/index.ts` (`receiveEmail()`) | Add fire-and-forget webhook to bridge after `stub.createEmail()` | ~10 |
| `workers/index.ts` (`receiveEmail()`) | Remove `agentStub.fetch()` auto-draft trigger | ~5 (delete) |
| `workers/index.ts` (`POST /emails`) | Add `?sync=true` — `await sendEmail()` instead of `waitUntil` | ~5 |
| `workers/index.ts` (`POST /emails`) | Fire-and-forget `email-sent` webhook after successful sync send | ~10 |
| `wrangler.jsonc` | Add `WEBHOOK_URL`, `WEBHOOK_SECRET` vars | ~3 |
| `workers/types.ts` | Add `WEBHOOK_URL`, `WEBHOOK_SECRET` to Env interface | ~2 |
| **No changes to `app.ts`** | CF Access Service Token validated at edge, existing JWT middleware handles it | 0 |

**Total fork diff: ~82 lines across 5 files.**

### Webhook Payload Contract

**`email-received` webhook** (Agentic Inbox → Bridge):
```json
{
  "event": "email-received",
  "mailboxId": "sofia.luz@ai.nimblersoft.com",
  "emailId": "uuid-assigned-by-agentic-inbox",
  "from": "sender@example.com",
  "fromName": "Sender Name",
  "to": ["sofia.luz@ai.nimblersoft.com"],
  "cc": ["silas.vertiz@ai.nimblersoft.com"],
  "subject": "Email subject",
  "threadId": "thread-uuid",
  "inReplyTo": "original-message-id",
  "messageId": "original-message-id",
  "hasAttachments": true,
  "attachmentCount": 2,
  "timestamp": "2026-06-13T01:05:12Z"
}
```

**`email-sent` webhook** (Agentic Inbox → Bridge, for dedup):
```json
{
  "event": "email-sent",
  "mailboxId": "sofia.luz@ai.nimblersoft.com",
  "emailId": "sent-email-uuid",
  "threadId": "thread-uuid",
  "to": "recipient@example.com",
  "subject": "Re: Email subject",
  "source": "web-ui",
  "timestamp": "2026-06-13T01:06:30Z"
}
```

## Phases

---

### Phase 0: Feature Review & Grilling Session ✅ COMPLETED

**Goal:** Finalize bridge architecture decisions.

**Status:** ✅ All decisions resolved during grilling session. See Decisions table above.

**Decisions Locked:**
- [x] Approval: exact-match "approve" reply, zero polling
- [x] Corrections: MM outgoing webhook (no trigger word), bridge filters internally
- [x] Dedup: Agentic Inbox `email-sent` webhook → bridge marks resolved
- [x] Bridge deployment: Docker + CF Tunnel
- [x] Bridge stack: Hono + TypeScript
- [x] API auth: CF Access Service Token (no code changes)
- [x] Webhook auth: shared secrets
- [x] Webhook payload: reference only, bridge fetches body
- [x] Send: existing API + `?sync=true`
- [x] Signatures: Agentic Inbox settings, Hermes skips generation
- [x] Restart recovery: startup reconciliation
- [x] CC routing: dropped (Scenario A, independent delivery)
- [x] Built-in AI: disabled
- [x] Self-sent detection: kept

---

### Phase 1: Setup & Deploy Agentic Inbox

**Goal:** Deploy ericmaster/agentic-inbox at `ai.nimblersoft.com` on Cloudflare Workers with multi-domain support and bridge integration patches.

**Steps:**
1.1 Clone `ericmaster/agentic-inbox` into `~/platform/agentic-inbox/`
1.2 Apply Commit 1: PR #49 patches (multi-domain support)
1.3 Apply Commit 2: Bridge integration patches (webhooks + sync send + auto-draft removal)
1.4 Initialize project `AGENTS.md` (setup context, deployment steps, fork modifications, known issues)
1.5 Configure `DOMAINS` var: `ai.nimblersoft.com,ericmaster.ninja,meliruns.com`
  - `ai.nimblersoft.com` is the **only** inbox domain cut over in Phase 1
  - `ericmaster.ninja` and `meliruns.com` are listed in `DOMAINS` so the Worker recognizes them, but their MX/Email Routing cutover is **DEFERRED to Phase 4** — both are **live on Zoho** today (`mx.zoho.com`). Do **NOT** enable catch-all on them in Phase 1.
  - `nimblersoft.com` is **NOT** included — stays on Google Workspace
  - Add `ericmaster.com` later when Eric confirms
1.6 Set up Cloudflare resources:
  - R2 bucket `agentic-inbox`
  - Durable Objects binding
  - Workers AI binding
1.7 Configure Cloudflare Access (one-click for Workers):
  - Set `POLICY_AUD` and `TEAM_DOMAIN` secrets via Infisical (Project Name: `Agentic Inbox`, Project ID: `6c293d88-cc3c-4a44-8368-faa22c8c0196`)
  - Create CF Access Service Token for bridge API access
  - Create Access Policy allowing the Service Token
  - Store Client ID + Client Secret in Infisical
1.8 Configure webhook secrets:
  - Generate `WEBHOOK_SECRET` (shared with bridge)
  - Set `WEBHOOK_URL` to `https://mail-bridge.nimblersoft.com/webhooks/agentic-inbox`
  - Store both in Infisical
1.9 Set up DNS + Email Routing — **`ai.nimblersoft.com` ONLY in Phase 1**:
  - `ai.nimblersoft.com` — point the Worker custom-domain record + enable CF Email Routing (catch-all → Agentic Inbox Worker).
    - **Cutover, not dual-run:** `ai.nimblersoft.com` currently has a single MX → Mailgun (OpenMail's backend). Switching MX to CF Email Routing is a **hard cutover** — once flipped, OpenMail receives no new mail for this domain. This is NOT zero-disruption. Validate first against a throwaway test address/subdomain before flipping the live MX.
    - **Rollback:** repoint MX back to Mailgun (OpenMail) if validation fails.
    - **DNS coexistence check:** `ai.nimblersoft.com` must serve the Worker (HTTP) AND hold CF Email Routing MX simultaneously. CF supports this (MX + proxied A/AAAA coexist; the Worker route must NOT be a conflicting CNAME). **Verify** both the web UI loads and mail routes after the change.
  - `nimblersoft.com` — **DO NOT change MX records. DO NOT set up Email Routing.**
  - `ericmaster.ninja` — **DEFERRED to Phase 4.** Live on Zoho. Do NOT enable Email Routing/catch-all now (would hijack all inbound Zoho mail before the Zoho data migration).
  - `meliruns.com` — **DEFERRED to Phase 4.** Live on Zoho. Same as above.
  - **Verify:** `ai.nimblersoft.com` has Email Routing enabled + catch-all → Worker; the two Zoho domains remain untouched.
1.10 Enable Email Service send binding for `ai.nimblersoft.com` (requires domain verification + SPF/DKIM). Defer per-domain send setup for `ericmaster.ninja`/`meliruns.com` to Phase 4.
1.11 Deploy: `npm run deploy`
1.12 Create mailboxes: `sofia.luz@ai.nimblersoft.com`, `silas.vertiz@ai.nimblersoft.com`
1.13 Configure per-mailbox signatures in Agentic Inbox settings
1.14 Validate: send test email to each mailbox, verify receipt, test send, test web UI

**Definition of Done:** ✅ **COMPLETE on the dedicated domain `nimblerbot.com`** (2026-06-17). The original `ai.nimblersoft.com` target was abandoned (shared-zone apex-MX conflict — see Execution Notes); items below reflect the `nimblerbot.com` deployment.
- [x] Agentic Inbox deployed & accessible — web UI at `https://ainbox.nimblerbot.com` behind Access (service-token API returns 200; `GET /api/v1/config` → `{"domains":["nimblerbot.com"]}`)
- [x] Single-domain config active (`DOMAINS=nimblerbot.com`; the two Zoho domains dropped from the list — still deferred to Phase 4)
- [x] Cloudflare Access configured (new `POLICY_AUD=814e4b55…` + unchanged `TEAM_DOMAIN` via Infisical)
- [x] CF Access Service Token (`agentic-inbox-bridge`) reused in the new app's policies (verified 200 against live API)
- [x] Webhook secrets configured (WEBHOOK_URL + WEBHOOK_SECRET — carried over unchanged)
- [x] Email Routing enabled on `nimblerbot.com` apex with **literal per-mailbox rules** (`sofia.luz@`/`silas.vertiz@ → Worker`); catch-all left disabled/drop
- [x] `nimblersoft.com` (Google) + `ericmaster.ninja` + `meliruns.com` (Zoho) MX UNTOUCHED — different zones, nothing modified
- [x] DNS coexistence: web UI on `ainbox.*` (proxied AAAA) + mail on the apex (MX) — clean separation
- [x] Email Sending verified for outbound on `nimblerbot.com` (DKIM `cf2024-1` + `cf-bounce.*` SPF/DKIM + `_dmarc p=reject`; single clean apex SPF)
- [x] Mailboxes created: `sofia.luz@nimblerbot.com`, `silas.vertiz@nimblerbot.com`
- [ ] Per-mailbox signatures configured — optional, pending (offered to Eric)
- [x] Built-in AI agent disabled (fork commit 47ef682 removes the auto-draft trigger)
- [x] Inbound: external→Worker test received & stored (`eric→sofia.luz@`; CF-internal `sofia→silas` also stored)
- [x] Outbound: sync send tested (`sofia→silas` internal + `sofia→eric@nimblersoft.com` external — landed in inbox, passes `p=reject`)
- [x] Eric validated personally: received the outbound test in his inbox, sent an inbound that was confirmed stored
- [x] `AGENTS.md` created in project root
- [x] nimblersoft.com Google Workspace MX confirmed UNMODIFIED (separate zone entirely; never touched)

**Risk Mitigation:**
- OpenMail stays operational for the OTHER OpenMail mailboxes during Phase 1, but `ai.nimblersoft.com` itself is a **hard MX cutover** (single MX). Validate on a test address/subdomain before flipping the live MX; rollback = repoint MX to Mailgun.
- If deployment fails: rollback DNS/Worker route + MX, keep OpenMail active
- Fork patches are small (~82 lines total) — easy to audit and revert
- Google Workspace MX on nimblersoft.com must NOT be touched
- `ericmaster.ninja` + `meliruns.com` stay on Zoho until Phase 4 — Phase 1 must not touch their MX/Email Routing

**Execution Notes — Live Infra (2026-06-16, supervised):**

Steps **1.5–1.10 + 1.11 done; 1.9 (inbound Email Routing) BLOCKED; 1.12–1.14 pending.**

Done & verified:
- **R2** bucket `agentic-inbox` created. **Worker deployed** (`agentic-inbox`, all bindings: MAILBOX/EMAIL_AGENT/EMAIL_MCP DOs, EMAIL send, BUCKET, AI). `DOMAINS=ai.nimblersoft.com,ericmaster.ninja,meliruns.com`.
- **Cloudflare Access:** self-hosted app `Agentic Inbox` → `ai.nimblersoft.com`, `POLICY_AUD=6189a26a…`, `TEAM_DOMAIN=https://nimblersoft.cloudflareaccess.com`. Service token `agentic-inbox-bridge` + 2 policies (Eric email; bridge service-token non_identity). Service token verified 200 against live `/api/v1/config`.
- **Secrets** (Worker `wrangler secret put` + mirrored to Infisical **Agentic Inbox/prod**): `POLICY_AUD`, `TEAM_DOMAIN`, `WEBHOOK_URL=https://mail-bridge.nimblersoft.com/webhooks/agentic-inbox`, `WEBHOOK_SECRET` (random). Bridge service-token creds in Infisical as `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`.
- **Custom domain:** `ai.nimblersoft.com` → Worker via Workers Domains API (proxied AAAA `100::`), coexists with MX. NOTE: `@cloudflare/vite-plugin` strips `routes` from the generated deploy config, so custom domains are API-managed, not via `wrangler.jsonc`.
- **Email Sending (outbound):** `ai.nimblersoft.com` onboarded (dashboard). CF isolated auth under `cf-bounce.ai.nimblersoft.com` (own SPF→cloudflare, MX→route*.mx.cloudflare.net for bounces) + DKIM `cf-bounce._domainkey.ai.nimblersoft.com` + `_dmarc.ai.nimblersoft.com p=reject`. **No SPF collision** — the `ai.nimblersoft.com` SPF (mailgun) was left untouched.
- **Credentials:** scoped `CLOUDFLARE_EMAIL_API_TOKEN` in Infisical **Nimblerbox/dev** (DNS:Edit + Email Routing Rules:Edit + Email Sending:Edit + Email Routing Addresses:Edit, all zones + account). The wrangler OAuth token lacks `email_*:write`; the broad `CLOUDFLARE_API_TOKEN` lacks email perms.

DNS before/after on `ai.nimblersoft.com`: MX unchanged (mailgun, prio 10); **added** proxied AAAA `100::` (web UI) + `cf-bounce.*` sending records. Apex `nimblersoft.com` MX = `aspmx.l.google.com` **UNCHANGED**. Zoho domains UNCHANGED.

**BLOCKER — Step 1.9 (inbound Email Routing):** `ai.nimblersoft.com` is a **subdomain inside the `nimblersoft.com` zone** (no separate zone). Cloudflare's Email Routing **enable wizard is zone-level and forces apex records** — it wanted to add `nimblersoft.com` MX→`route1/2/3.mx.cloudflare.net` (a mail-loss fallback trap behind Google's prio-0 MX) **and a duplicate apex SPF** (`v=spf1 include:_spf.mx.cloudflare.net` → two SPF records = permerror, degrades Google Workspace SPF). Enabling routing is **not exposed as an API-token permission** (only "Email Routing Rules" exists, which manages rules but not the enable toggle), so it can't be done apex-safely via the token. **Stopped per guardrail 1** (never touch `nimblersoft.com` apex MX).

**CONCLUSIVE (2026-06-17):** attempting to enable Email Routing on `nimblersoft.com` returns
*"Existing non-Cloudflare MX records conflict with Email Routing. Remove or update them and try
again."* — Cloudflare **refuses to enable Email Routing while the apex has foreign (Google) MX** and
demands their removal. There is **no subdomain-only path on a shared zone**: routing is apex-gated and
incompatible with keeping Google on the apex. The shared-`nimblersoft.com`-zone approach is therefore
**ruled out** (the apex enable also errored cleanly — added nothing; apex verified pristine, 68 records).

**DECISION:** use a **dedicated domain** for the agent inbox (its own Cloudflare zone, mail at the
apex — the single-domain setup agentic-inbox is designed for). Eric is acquiring a new domain and
adding it to Cloudflare. This also gives reputation/blast-radius isolation from Google Workspace.

When the dedicated domain's zone is active in CF, resume Phase 1 for it (most work carries over —
Worker code/R2/DOs/AI/bridge contracts unchanged; replay DOMAINS, Access app+POLICY_AUD, custom
domain, Email Sending onboarding, then Email Routing on the apex + literal mailbox rules). The
`ai.nimblersoft.com` Access app / custom domain / Email Sending onboarding become moot (decommission
or repurpose the web-UI host as a follow-up).

After G is unblocked: literal per-mailbox routing rules (`sofia.luz@`/`silas.vertiz@ → Worker`) instead of a zone-wide catch-all (avoids intercepting the `cf-bounce` MX); inbound handler has **no domain guard** — it stores only for addresses with an existing mailbox. Cutover = delete `ai.nimblersoft.com` mailgun MX (Eric authorized); rollback = re-add `mxa/mxb.eu.mailgun.org` prio 10.

---

**✅ RESOLVED — live on `nimblerbot.com` (2026-06-17, supervised):** Eric acquired `nimblerbot.com` (registrar name.com → Cloudflare nameservers; zone active in account `71f942c5…`, the **same** account as the Worker — required for custom domain / routing-to-Worker / Email Sending). Phase 1 was replayed on it; the address↔mailbox mapping is `mailboxId = lowercase email address` (`workers/index.ts` mailbox key `mailboxes/{email}.json`; `receiveEmail` uses `allRecipients[0]` since `EMAIL_ADDRESSES=[]`).

- **Config:** `DOMAINS=nimblerbot.com`; redeployed (version `1fd09c31`, then a `secret put` version).
- **Access:** new self-hosted app `Agentic Inbox (nimblerbot.com)` → `ainbox.nimblerbot.com` (`id=efb1a4c3…`, `POLICY_AUD=814e4b55…`); same `TEAM_DOMAIN`; same `agentic-inbox-bridge` service token (`id=658c03a3…`) added to its 2 policies (Eric email allow + bridge `non_identity`). `POLICY_AUD` written to the Worker secret + Infisical **Agentic Inbox/prod** (old `6189a26a…` overwritten).
- **Custom domain:** `ainbox.nimblerbot.com` → Worker (proxied AAAA `100::`) via Workers Domains API. Apex reserved for mail only — no AAAA/MX coexistence needed (cleaner than the `ai.*` plan).
- **Email Routing:** enabled on the apex (clean — fresh zone, no foreign-MX conflict). Literal rules `sofia.luz@`/`silas.vertiz@ → agentic-inbox`; catch-all disabled (drop).
- **Email Sending:** `nimblerbot.com` onboarded. **Final apex DNS** (12 records): proxied AAAA `ainbox`; 3× MX `route1/2/3.mx.cloudflare.net`; apex SPF `v=spf1 include:_spf.mx.cloudflare.net ~all` (single — no collision); `_dmarc p=reject`; DKIM `cf2024-1._domainkey`; plus `cf-bounce.*` (MX + SPF + DKIM) for sending bounces.
- **Mailboxes:** `sofia.luz@nimblerbot.com` (Sofia Luz), `silas.vertiz@nimblerbot.com` (Silas Vertiz).
- **Validated:** `sofia→silas` (CF-internal, stored on first poll); `sofia→eric@nimblersoft.com` (external — landed in **inbox**, passes `p=reject`); `eric→sofia` (external inbound — stored); global NS/MX/SPF/DKIM/DMARC propagation confirmed via `8.8.8.8` + `1.1.1.1`.
- **Teardown/rollback** (net-new system — no prior mail to revert): delete the 2 routing rules + 2 mailboxes, remove the Access app (`efb1a4c3…`) + custom domain, offboard Email Sending, disable Email Routing.
- **Follow-ups:** (a) decommission the now-moot `ai.nimblersoft.com` Access app (`142c5fd6…`) / custom domain / Email Sending onboarding; (b) optional per-mailbox signatures; (c) Phase 2 bridge (`WEBHOOK_URL=https://mail-bridge.nimblersoft.com/…` not live yet — `notifyBridge` no-ops/logs on failure, so inbound/outbound are unaffected).

---

### Phase 2: Bridge Migration

**Goal:** Build webhook-driven bridge between Agentic Inbox and Mattermost. Integrate Hermes `/v1/responses` for persona-aware reply generation. Replace OpenMail dependencies.

**Architecture:**
```
┌─────────────────────┐     ┌──────────────────────────┐     ┌───────────────────┐
│ Agentic Inbox       │────>│ Bridge (Hono + TS)       │────>│ Mattermost        │
│ Worker              │     │ POST /webhooks/           │     │ (notifications)   │
│  ↓ (email-received  │     │   agentic-inbox          │     │  ↓ (outgoing      │
│   webhook)          │     │ POST /webhooks/           │     │   webhook)        │
│  ↓ (email-sent      │     │   mattermost             │<────│ "approve" reply   │
│   webhook)          │     │  ↓                        │     │ correction reply  │
│                     │     │ GET /api/v1/.../emails/:id│     └───────────────────┘
│                     │     │  (fetch email body)       │
│                     │     │  ↓                        │
│                     │     │ Hermes /v1/responses      │
│                     │     │  ↓                        │
│                     │     │ POST /api/v1/.../emails   │────> Send email
│                     │     │  (?sync=true)             │     │ (via Agentic Inbox
│                     │     │                           │     │  API + CF Access
│                     │     │                           │     │  Service Token)
│                     │     └──────────────────────────┘
└─────────────────────┘
```

**Steps:**

2.1 **Build bridge project** (`~/agentic/agentic-inbox-bridge/`):
  - Hono + TypeScript, Node.js runtime
  - `Dockerfile` + `docker-compose.yml` (same pattern as `hermes-mm-bridge`)
  - `AGENTS.md` with architecture, data flow, env vars

2.2 **Bridge endpoints:**
  - `POST /webhooks/agentic-inbox` — receives `email-received` and `email-sent` events from Agentic Inbox
    - Validates `X-Webhook-Secret` header
    - `email-received`: fetch email body via API → post MM notification → call Hermes → post suggestion as threaded reply → track in pending-replies
    - `email-sent`: find pending by threadId → mark as "sent via web UI" → update MM post with audit trail
  - `POST /webhooks/mattermost` — receives all posts from configured channel(s) via MM outgoing webhook
    - Validates webhook token in payload
    - If message is exact-match "approve" (case-insensitive, trimmed) AND is a reply to a known root_post_id → approval flow
    - If message is a non-bot reply to a known root_post_id AND not "approve" → correction flow
    - Otherwise → ignore
  - `GET /health` — health check endpoint for Uptime Kuma monitoring

2.3 **Bridge core logic:**
  - **Agentic Inbox API client:** wraps all API calls with CF Access Service Token headers (`CF-Access-Client-Id` + `CF-Access-Client-Secret`)
  - **Email fetch:** `GET /api/v1/mailboxes/:mailboxId/emails/:emailId` to retrieve full body
  - **Email send:** `POST /api/v1/mailboxes/:mailboxId/emails?sync=true` with `{ to, from, subject, html, text, thread_id, in_reply_to }`
  - **Hermes integration:** `POST /v1/responses` with persona system prompt from `config/agents.json`
    - Conversation key: `agentic-inbox-{mailbox_address}-{thread_id}`
    - Correction: `previous_response_id` chaining (same as current)
    - System prompt updated: "No generes firma — se agrega automáticamente al enviar."
  - **Per-agent routing:** `config.json` maps mailbox address → agent → MM channel
  - **Pending replies:** `pending-replies.json` with reverse lookup (`root_post_id → suggestion_post_id`)
  - **Self-sent detection:** if sender matches any configured mailbox address → notification only, no draft
  - **Owner auto-send:** `AUTO_REPLY_OWNER_EMAILS` config — matching senders skip approval, send immediately

2.4 **Mattermost outgoing webhook registration:**
  - Register outgoing webhook on email channel(s) — **no trigger word** (fires on all posts)
  - Webhook URL: `https://mail-bridge.nimblersoft.com/webhooks/mattermost`
  - Content type: `application/json`
  - Verify webhook fires reliably (test with manual post)

2.5 **Configure CF Tunnel:**
  - Add `mail-bridge.nimblersoft.com` route in `~/.cloudflared/config.yml`
  - Point to bridge container port
  - Restart cloudflared

2.6 **Configure routing:**
  - `config.json`: mailbox address → agent → channel mapping (same structure as current, keyed by address instead of OpenMail inbox ID)
  - `config/agents.json`: agent personas with updated system prompts (no signature generation)
  - `AUTO_REPLY_OWNER_EMAILS`: owner addresses that bypass approval

2.7 **Test full flow:**
  - Inbound: external email → Agentic Inbox → webhook → bridge fetches body → MM notification → Hermes draft → "approve" → send
  - Correction: reply to suggestion thread → MM webhook → bridge → revise via Hermes → MM post update
  - Owner auto-send: skip approval for configured sender
  - Self-sent: Sofia sends to Silas → notification only, no draft
  - Web UI dedup: approve via web UI → email-sent webhook → bridge marks resolved → MM post updated
  - MM + web UI race: both triggered → dedup lock prevents duplicate send

2.8 **Test restart recovery:**
  - Stop bridge → type "approve" in MM → start bridge → verify reconciliation picks up missed approval

2.9 **Test with both mailboxes:** sofia.luz@ai.nimblersoft.com and silas.vertiz@ai.nimblersoft.com

2.10 **Set up Uptime Kuma monitoring** for `https://mail-bridge.nimblersoft.com/health`

**Definition of Done:**
- [ ] Bridge running as Docker container behind CF Tunnel
- [ ] Full inbound flow working: email → webhook → fetch → MM → Hermes draft → "approve" → sent
- [ ] Correction flow working via MM outgoing webhook (no polling)
- [ ] Per-agent personas active (Sofia/Silas) with updated system prompts
- [ ] Web UI + MM "approve" deduplication working (no duplicate sends)
- [ ] Owner auto-send working
- [ ] Self-sent loop detection working
- [ ] Restart recovery working (missed "approve" reconciled on boot)
- [ ] Both mailboxes tested end-to-end
- [ ] Uptime Kuma monitoring active
- [ ] `AGENTS.md` created in bridge project root
- [ ] No OpenMail dependencies in new bridge code

---

### Phase 3: Decommission OpenMail

**Goal:** Remove all OpenMail references, stop bridge, clean up credentials.

**Steps:**
3.1 Verify Phase 2 running for ≥7 days with no issues
3.2 Stop OpenMail bridge: `docker compose down` in `~/agentic/hermes-mail-mm-bridge/`
3.3 Remove OpenMail CLI: `npm uninstall -g @openmail/cli`
3.4 Remove `~/.openmail-cli/` config
3.5 Rotate/remove OpenMail API key from Infisical
3.6 Archive `~/agentic/hermes-mail-mm-bridge/` → `~/agentic/hermes-mail-mm-bridge.archived/`
3.7 Update project context in AGENTS.md across relevant projects
3.8 DNS cleanup: verify `ai.nimblersoft.com` points solely to Agentic Inbox Worker (remove any OpenMail-specific routes)
3.9 Update `nimbler-ops/AGENTS.md` project table: move `hermes-mail-mm-bridge` to archived, add `agentic-inbox-bridge`

**Definition of Done:**
- [ ] OpenMail bridge stopped and disabled
- [ ] No running processes depending on OpenMail
- [ ] API key removed from Infisical and all configs
- [ ] CLI uninstalled
- [ ] Project archived (not deleted — reference)
- [ ] All docs updated
- [ ] DNS confirmed: only Agentic Inbox serves ai.nimblersoft.com
- [ ] `nimbler-ops/AGENTS.md` updated

---

### Phase 4: Zoho Migration & Subscription Cancellation (DEFERRED)

**Priority:** LOW — defer until Phases 1-3 complete and agentic-inbox stable for ≥2 weeks.

**Goal:** Cut over `ericmaster.ninja` + `meliruns.com` inbound mail from Zoho to Agentic Inbox, migrate select Zoho emails, and cancel the Zoho subscription. **The MX/Email-Routing cutover for these two domains lives HERE, not in Phase 1** — flipping it earlier would hijack live Zoho inbound before the data is migrated.

**Steps (scope to be refined when activated):**
4.1 Audit Zoho Mail: which accounts, how much data, which emails to migrate
4.2 Export from Zoho (Eric to check export options: IMAP, .eml, etc.)
4.3 Determine import mechanism to Agentic Inbox (API bulk upload? DO SQLite direct? R2 attachments?)
4.4 Execute partial migration (specific emails only, recent)
4.5 Verify imported emails visible and searchable
4.6 **Cut over MX:** enable CF Email Routing + catch-all → Worker on `ericmaster.ninja` and `meliruns.com`, replacing Zoho MX. Enable Email Service send (SPF/DKIM) per domain. Validate inbound + outbound per domain before declaring done.
4.7 Cancel Zoho subscription after verification period

**Definition of Done:**
- [ ] Selected Zoho emails imported and accessible in Agentic Inbox
- [ ] Search functionality verified on imported emails
- [ ] `ericmaster.ninja` + `meliruns.com` MX cut over to CF Email Routing; inbound + outbound verified per domain
- [ ] Zoho subscription cancelled

---

## Risk Register

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| PR #49 not compatible with latest upstream | Medium | Low | Fork is clean; patches are small and well-scoped |
| Multi-domain Email Routing misconfigured | High | Medium | Test each domain individually before cutover |
| Phase 1 catch-all hijacks live Zoho mail on ericmaster.ninja/meliruns.com | Critical | Medium | Both domains' MX/catch-all cutover deferred to Phase 4; Phase 1 touches `ai.nimblersoft.com` only; Phase 1 DoD asserts their MX unchanged |
| `ai.nimblersoft.com` MX cutover loses in-flight mail | Medium | Low | Hard single-MX cutover — validate on test address first; rollback = repoint MX to Mailgun |
| Bridge webhook delivery fails (bridge down) | Medium | Low | Email still stored in DO. Bridge reconciles on restart. Uptime Kuma alerts. |
| MM outgoing webhook misconfigured | Medium | Low | Test with manual post before go-live |
| Dual-approval (MM "approve" + web UI) causes duplicate sends | Medium | Low | `email-sent` webhook + dedup lock in pending-replies.json |
| CF Access Service Token expires/rotated | Medium | Low | Monitor token health. Stored in Infisical for easy rotation. |
| Hermes persona integration API changes | Low | Low | `/v1/responses` contract is stable; conversation keying unchanged |
| Email delivery disruption during cutover | High | Low | Phased approach; both providers active until Phase 3 |
| Zoho import not supported by Agentic Inbox | High | High | May need manual DO SQLite injection or direct import script — assess when Phase 4 activates |
| nimblersoft.com MX accidentally modified | Critical | Low | Explicit gate in Phase 1 DoD — verify Google Workspace MX unmodified |
| `?sync=true` send timeout (slow delivery) | Low | Low | Email Service delivery is typically <1s. Bridge has generous timeout. |

## Files Likely to Change

| File/Directory | Phase | Change Type |
|------|-------|-------------|
| `~/platform/agentic-inbox/` (NEW) | 1 | Created (clone of fork) |
| `~/platform/agentic-inbox/AGENTS.md` (NEW) | 1 | Created |
| `~/platform/agentic-inbox/workers/index.ts` | 1 | PR #49 patches + webhook emission + sync send + auto-draft removal |
| `~/platform/agentic-inbox/workers/types.ts` | 1 | Add WEBHOOK_URL, WEBHOOK_SECRET to Env |
| `~/platform/agentic-inbox/wrangler.jsonc` | 1 | PR #49 patches + webhook vars + multi-domain DOMAINS |
| `~/platform/agentic-inbox/README.md` | 1 | PR #49 patches |
| `~/agentic/agentic-inbox-bridge/` (NEW) | 2 | Created — new bridge project (Hono + TS) |
| `~/agentic/agentic-inbox-bridge/AGENTS.md` (NEW) | 2 | Created |
| `~/agentic/hermes-mail-mm-bridge/` | 3 | Archived |
| Cloudflare Email Routing rules | 1, 4 | Phase 1: `ai.nimblersoft.com` only · Phase 4: `ericmaster.ninja` + `meliruns.com` (Zoho cutover) |
| Cloudflare Access Service Token | 1 | Created for bridge API access |
| Cloudflare Worker secrets (Infisical) | 1 | POLICY_AUD, TEAM_DOMAIN, WEBHOOK_URL, WEBHOOK_SECRET |
| CF Tunnel config (`~/.cloudflared/config.yml`) | 2 | Add mail-bridge.nimblersoft.com route |
| MM outgoing webhook config | 2 | Created for email channel(s) |
| Uptime Kuma monitor | 2 | Add mail-bridge health check |
| `nimbler-ops/AGENTS.md` | 2, 3 | Updated project tables |

## Delegation Strategy

| Phase | Execution | Rationale |
|-------|-----------|-----------|
| **Phase 0** | ✅ **COMPLETED** | All decisions resolved during grilling session |
| **Phase 1** | Orchestrator → 2 subagents parallel | A: clone + patch + AGENTS.md / B: CF resources + secrets + Access |
| **Phase 2** | Orchestrator → subagent (impl) + subagent (review) | Bridge build + code review. Architecture fully pre-defined. |
| **Phase 3** | **Sequential orchestrator** | Safety-sensitive — no parallel ops on decommission |
| **Phase 4** | Delegated when activated | Low priority, deferred |

## Phase Status Tracking

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 0 | ✅ Completed | Grilling session resolved all architecture decisions |
| Phase 1 | ✅ Complete | Live + validated on dedicated domain **`nimblerbot.com`** (web UI `ainbox.nimblerbot.com`; inbound + outbound tested internal & external, 2026-06-17). Shared `ai.nimblersoft.com` zone abandoned (apex-MX conflict). Pending follow-ups: decommission `ai.*` resources; optional signatures. |
| Phase 2 | ⬜ Not Started | Requires Phase 1 completion. Architecture fully defined. |
| Phase 3 | ⬜ Not Started | Requires Phase 2 stable (≥7 days) |
| Phase 4 | ⬜ Deferred | Low priority. Activate after Phase 3. |
