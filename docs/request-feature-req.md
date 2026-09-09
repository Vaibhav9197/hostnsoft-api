# Requirement: Feature Requests & Feedback (dashboard + AI agent)

**Updated 2026-09-09**: all three endpoints below were renamed from
`.../feature-requests` to `.../customer-query` (same underlying
`FeatureRequest` table, same behavior — external route name only). A
third `type`, `"other"`, was added alongside `"feature"`/`"feedback"`
(§1). A super-admin listing endpoint now exists —
`GET /admin/customer-query`, paginated and filterable on every field, see
`docs/admin-panel.md` — superseding §"Explicitly out of scope"'s original
"no read/list endpoint" note below. Separately, `isSuperAdmin` is now
included in user data sent to the dashboard (`GET /auth/me`,
`POST /auth/msg91/exchange`) so admin-only UI can be shown conditionally
— unrelated to this feature's own data, noted here only because it
shipped in the same pass.

## Purpose

Give customers — and the AI agents they deploy through — a lightweight way
to request a feature or leave feedback, without that turning into a support
ticket system. Two independent submission paths feed the same store:

1. **Embarko UI** — a logged-in dashboard user (email captured automatically,
   no need to ask) or an anonymous visitor on the public site (email is the
   only thing we ask for).
2. **An AI agent** — the same agent a customer is already using to deploy
   apps (Claude Code, Claude in a chat client, ChatGPT, etc.) can submit a
   request or suggestion on its own initiative, in the context of the app it
   just deployed. **Which agent made the request must be recorded** — this
   is the one hard requirement of this path.

## Why this lives across both repos

`hostnsoft-api` owns persistence and the dashboard-facing surface, same as
everything else (companies, projects, tokens). But the AI-agent path doesn't
talk to `hostnsoft-api` directly — per `docs/CLAUDE.md`'s tokens section, a
deploy token is never used to call this API, only against
`hostnsoft-deploy`'s deploy-time endpoints. So the agent path is a new
`hostnsoft-deploy` endpoint (same trust model as `GET /apps/:appName/status`
and `.../logs` — reuses `authorizeAppAccess`), which forwards to a new
internal `hostnsoft-api` endpoint to persist it — the same shape as
`recordDeployment` → `POST /internal/deployments/record`.

## Functional requirements

### 1. `type`: feature request vs. feedback vs. other

Every submission is one of `"feature"`, `"feedback"`, or `"other"` — a
required field on every path, not inferred. `"other"` added 2026-09-09 for
anything that doesn't cleanly fit the first two (a question, a support-ish
query) without forcing a miscategorization.

### 2. Path A — Embarko UI, logged in

`POST /companies/:companyId/customer-query`, same auth as every other
dashboard route (`proxy_auth_token` header, `loadCompanyContext`). Body is
just `{type, message}` — **email is never asked for**, it's read off the
already-verified proxy identity (`req.proxyIdentity.email`), exactly like
`GET /auth/me` already does. `companyId` and the caller's proxy `userId` are
recorded too, since this path always has both.

### 3. Path B — Embarko UI, not logged in

`POST /public/customer-query` — open, unauthenticated, same shape as the
existing `POST /public/deploy-tokens/request` (mounted before every
`requireProxyToken` router, rate-limited the same way: per-email, per-IP,
and global rolling windows via the existing Redis-backed limiter). Body is
`{type, message, email}` — `email` is **required** here since there's no
session to read it from. No `companyId`/`userId` — this caller may not even
have an account yet.

### 4. Path C — AI agent, during/around a deploy

`POST /apps/:appName/customer-query` on `hostnsoft-deploy` — **same auth
shape as `GET /apps/:appName/status`**: `Authorization: Bearer <deploy
token>` is optional; present, it must belong to the company that owns
`appName` (else `404`, never confirming the app exists to a foreign token);
absent, only allowed while `appName` is still an unclaimed orphan. This
means an agent can submit feedback about an app it just deployed
anonymously, before ever claiming it with a real token — matching every
other orphan-friendly endpoint on this platform.

Body: `{type, message}`, plus a **required** `X-Agent-Name` header — free
text (not a fixed enum: `claude-code`, `claude-chat`, `chatgpt`, `cursor`,
whatever comes next — a new agent must never need a code change here to be
recorded correctly). `hostnsoft-deploy` resolves `appName` to
`companyId`/`isOrphan` (already does, via `project-lookup.js`, for the
status/logs auth check) and forwards everything to `hostnsoft-api`'s
`POST /internal/customer-query` — no `requireProxyToken`, same trust model
as every other `/internal/*` route (network-level trust between the two
services, not a re-authenticated call).

### 5. What gets stored

One `FeatureRequest` row per submission, whichever path it came from:

| Field | Path A (dashboard) | Path B (public) | Path C (agent) |
|---|---|---|---|
| `type` | required | required | required |
| `message` | required | required | required |
| `source` | `"dashboard"` | `"public"` | `"agent"` |
| `email` | from proxy identity | required in body | `null` |
| `userId` | proxy userId | `null` | `null` |
| `companyId` | from URL | `null` | from token, or `null` if orphan |
| `projectSlug` | `null` | `null` | the app name |
| `agentName` | `null` | `null` | required (`X-Agent-Name`) |

### 6. Validation

`message`: required, non-empty, capped (e.g. 5,000 chars) — this is
feedback text, not a support-ticket body; a hard cap keeps one bad actor
from storing arbitrarily large blobs. `email` (path B): standard email
validation, same as the public token endpoint. `agentName` (path C):
required, non-empty, capped (e.g. 100 chars) — free text, no allowlist.

### 7. Rate limiting

Path B (public, unauthenticated) reuses the exact limiter pattern already
built for `POST /public/deploy-tokens/request` — its own Redis-backed
per-email/per-IP/global windows, not shared counters with the token
endpoint (a burst of feedback shouldn't threaten someone's ability to
request a deploy token, or vice versa). Paths A and C already require a
real credential (a proxy session or a live/orphan deploy target), so no
separate rate limit for them in this pass.

## Explicitly out of scope for this pass

- ~~**No read/list endpoint.**~~ **Added 2026-09-09**:
  `GET /admin/customer-query`, super-admin only, paginated and filterable
  on every field — see `docs/admin-panel.md`.
- **No status/response workflow** (acknowledged, planned, shipped, etc.) —
  just a durable record of what was asked for for now.
- **No attachments.** Text only.
- **No de-duplication** across repeated similar submissions — every
  submission is its own row.
