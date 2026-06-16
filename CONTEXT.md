# CONTEXT.md — agentic-inbox glossary

Project-local terminology. Defers to `~/nimbler-ops/CONTEXT.md` for company-wide terms; only
project-specific language is defined here. Use these terms verbatim.

- **Agentic Inbox** — this service. Self-hosted email app for AI agents on Cloudflare Workers,
  fork of `cloudflare/agentic-inbox`. Reachable at `ai.nimblersoft.com`.
- **Bridge** — `agentic-inbox-bridge` (`~/agentic/agentic-inbox-bridge/`, PLAN Phase 2). The
  Hono/TypeScript daemon that connects Agentic Inbox ↔ Mattermost ↔ Hermes. This repo only emits
  webhooks to it; it is not built here.
- **Mailbox** — a Durable Object (SQLite) keyed by full email address (e.g.
  `sofia.luz@ai.nimblersoft.com`). Holds that address's emails, folders, settings.
- **email-received webhook** — reference-only event Agentic Inbox fires to the bridge when mail
  arrives. Carries IDs/metadata, not the body; the bridge fetches the body via the API.
- **email-sent webhook** — event fired on the **async (web-UI) send path** so the bridge can dedup
  against a pending Mattermost approval. `source:"web-ui"`. Not fired on the sync path.
- **sync send** — `POST /emails?sync=true`: blocks until delivery and returns the result inline.
  The bridge's "approve" path uses this; it does not produce an email-sent webhook.
- **Hermes** — Nimblersoft's agent platform; sole reply-draft generator (`/v1/responses`). The
  built-in Workers AI auto-draft is disabled in this fork.
- **Persona** — a Hermes agent identity bound to a mailbox (e.g. Sofia → `sofia.luz@`,
  Silas → `silas.vertiz@`).
- **DOMAINS** — comma-separated list of domains one instance serves. Listing a domain ≠ cutting it
  over; cutover = pointing its MX/Email Routing at the Worker.
- **OpenMail** — the SaaS email provider being replaced (`api.openmail.sh`, Mailgun-backed). The
  legacy bridge is `~/agentic/hermes-mail-mm-bridge/` (archived in PLAN Phase 3).
