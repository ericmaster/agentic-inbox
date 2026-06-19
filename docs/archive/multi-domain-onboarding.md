# [ARCHIVED] Multi-domain onboarding — ericmaster.ninja + meliruns.com (+ ericmaster.com)

**Status:** Completed & live. Executed 2026-06-18. This is an archived summary of the work as actually
delivered; it supersedes the original draft plan + handoff prompt (both removed). Ongoing operational
state lives in the memory `agentic-inbox-multidomain-onboarding`.

## Goal
Bring Eric's Zoho-hosted personal domains into Agentic Inbox and retire Zoho. Builds on the live
`nimblerbot.com` system (Phase 1 inbound + Resend outbound — see `agentic-inbox-outbound-resend`).

## Final scope (diverged from the original draft during execution)
The draft assumed full-agentic treatment and config-only changes. Discovery changed both:

- **Treatment = notify-only**, not full-agentic. The real Zoho archive (348 emails, one consolidated
  personal inbox 2018–2026) was overwhelmingly transactional/personal (PayPal, tax/SRI, Apple, a 123×
  recurring sender) — drafting a persona reply to every receipt would have drowned Mattermost. Inbound
  posts a heads-up notification only; no Hermes draft/approve.
- **Three domains, three treatments:**
  - `ericmaster.ninja` — agentic-inbox mailbox `me@ericmaster.ninja` (notify-only). Own Resend account.
  - `meliruns.com` — agentic-inbox mailboxes `hello@meliruns.com`, `eric.aguayo@meliruns.com`
    (notify-only). Own Resend account.
  - `ericmaster.com` — **not** onboarded to agentic-inbox; CF Email Routing catch-all **forward →
    eric7master@gmail.com** (this domain held most of the real history).
  - `meli.run` — legacy, no longer controlled; dropped (its archived mail imported into meliruns).
- **Per-domain Resend accounts** (not one shared account). Eric created a separate Resend account per
  domain, which broke the draft's "config-only" premise and forced a Worker code change.

## Delivered (live + validated)
- **Worker** (agentic-inbox **PR #4**, deployed): `DOMAINS=nimblerbot.com,ericmaster.ninja,meliruns.com`;
  per-domain Resend key resolution in `workers/lib/resendKeys.ts` via the `RESEND_DOMAIN_KEYS` var
  (`{"ericmaster.ninja":"RESEND_ERICMASTER_NINJA","meliruns.com":"RESEND_MELIRUNS"}`); the Resend webhook
  verifies against all configured secrets behind one URL. 3 mailboxes created; **literal** Email Routing
  rules → Worker (no catch-all, for spam control). Worker secrets: `RESEND_ERICMASTER_NINJA_*`,
  `RESEND_MELIRUNS_*`, plus the default `RESEND_*` (= nimblerbot).
- **History import** (agentic-inbox **PR #6**): one-time `.eml` import route
  `POST /api/v1/mailboxes/:id/import` (preserves the original `Date`). 175/175 imported (a filter dropped
  173 bulk/marketing); 168 → `me@ericmaster.ninja`, 7 → `hello@meliruns.com`.
- **Outbound** validated from both new domains (`provider:resend, fallback:false`) — proves per-domain
  account resolution works.
- **Bridge** notify-only mode (bridge **PR #4**): `MailboxRoute.mode="notify"` posts a heads-up, no draft.
  Posts via the **silas** bot (Mattermost forbids a bot creating another bot, so silas was reused) to
  per-domain MM channels `ericmaster-mail` (`ii3fqu8kqpgwufjxqaces4u59o`) and `meliruns-mail`
  (`hsmhu7sqp384ucejed4asezoke`), team `gn5wzcffpp8n5cmz3o88sw3mmw`. Inbound→notify validated end-to-end.
- **CF Email Sending fallback parity** confirmed per domain (cf2024-1 DKIM + cf-bounce MX), consistent
  with the global Resend→Cloudflare outbound fallback.

## Gotchas to carry forward
- **Deploy with `npx wrangler deploy --keep-vars`** (after `npm run build`). A bare `npm run deploy`
  deletes any var not in `wrangler.jsonc`, which would drop the out-of-band `EMAIL_PROVIDER=resend` /
  `EMAIL_FALLBACK_CLOUDFLARE=true` and break live nimblerbot outbound. Verify vars post-deploy via the
  Worker settings API.
- Per-domain Resend keys are **restricted send-only** (401 on `GET /domains`): no domain/DKIM
  introspection via API. Resend auto-wrote the DKIM/return-path records into the CF zones; manage them in
  the dashboard or with a full-access key.

## Remaining (human-gated)
- 🔴 **ericmaster.com forwarding is blocked** on Eric clicking the CF verification email to
  `eric7master@gmail.com` (destination currently `verified=False`); until then ericmaster.com inbound
  bounces. Once verified, enable the catch-all: `PUT` zone `432ffe4eabddad5981f010bccfc9e950`
  `/email/routing/rules/catch_all` forward → `eric7master@gmail.com` (currently errors 2054 not-verified).
- **Zoho cancellation** (Eric), after a soak.

## References
- Memory: `agentic-inbox-multidomain-onboarding` (ongoing state), `agentic-inbox-outbound-resend`.
- Code: agentic-inbox PR #4 (per-domain Resend), PR #6 (import route); bridge PR #4 (notify mode).
- CF zone ids: ericmaster.ninja `5508c9ae2c5bb5849a527d24c2c3f6eb`, meliruns.com
  `5c41a5aaf88bc8f8257d2f38e9b1f74c`, ericmaster.com `432ffe4eabddad5981f010bccfc9e950`.
