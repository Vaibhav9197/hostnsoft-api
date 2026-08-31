# hostnsoft-api — Project Brief

## What this project is

An API-only service (no frontend in this repo) that sits in front of the
existing `hostnsoft-deploy` deploy service and adds multi-tenant account
management: users, companies, projects, scoped deploy tokens, and
visibility into what's running (health, versions, resource usage, env
vars, logs).

`hostnsoft-deploy` (see `../docs/hostnsoft-context-gist.md`) already handles the
actual build-and-deploy mechanics — receiving a tarball, running Railpack,
generating a Nomad job spec, deploying it. It currently trusts a single
shared `PLATFORM_TOKEN` for all deploys. This project's job is to put a
real access-control layer in front of that: per-company tokens, roles, and an
API for everything a company needs to manage its apps day to day.

**Read `../docs/hostnsoft-context-gist.md` AND `../docs/session-log-storage-and-security.md`
before making infrastructure decisions** — together they document the
real Nomad/Traefik/Docker setup this service will integrate with,
including a real incident (OOM investigation), a rejected design (a
storage compatibility shim — don't re-propose it without reading why it
was rejected), the current multi-tenant isolation gaps (CPU/disk quota/
network isolation are NOT fully enforced today — directly relevant to a
project that's about to formalize multi-tenancy), and an existing
app-registry stopgap this project should likely absorb. Don't re-derive
infrastructure assumptions from scratch; check there first.

## Data model / hierarchy

```
User
 ├─ email (unique — exists even before first OAuth login, see Members below)
 ├─ identity linked via OAuth on first login (provider, provider_user_id) — see Auth flow
 ├─ has zero or more RefreshTokens (dashboard session refresh — id, token_hash,
 │   created_at, expires_at, revoked_at)
 └─ has one or more CompanyMemberships (role: company_admin | project_admin | viewer,
     status: invited | active)
     └─ Company
         ├─ has one or more DeployTokens (label, created_at, revoked_at, last_used_at)
         └─ has one or more Projects
             ├─ slug (immutable — the identifier hostnsoft-deploy actually
             │   uses, e.g. app-name convention: lowercase + dashes)
             ├─ name (mutable display name, independent of slug)
             └─ Project == one deployed app on hostnsoft-deploy, identified by slug
                 ├─ Deployments (versioned history — one row per deploy attempt,
                 │   success/failure, image tag, memory allocation, timestamp)
                 ├─ EnvVars (key/value, scoped to the project)
                 └─ current resource allocation (memory, and cpu once that's
                     enforced — see gist's open question on cpu_hard_limit)
```

Notes on roles (confirm/refine before building — this is a first pass):
- **company_admin**: full control at the company level — manage tokens (create,
  rotate, revoke, label), manage company membership/roles, everything a
  project_admin can do on every project in the company.
- **project_admin**: manage env vars and memory allocation for their
  project(s), trigger deploys (if tokens are also project-scoped — TBD,
  see open questions), view everything about their project(s).
- **viewer**: read-only — app health, deployment history, resource usage,
  logs. No mutation of anything.

A user can belong to multiple companies with different roles in each — role is
per-(user, company) pair, not global to the user.

## Auth flow (simplified — two separate, independent concerns)

**The agent never logs in as the person, and never holds a session on
their behalf.** It only ever needs one thing: a company-scoped **Deploy
Token** (already specced below). Getting that token the first time is a
one-time manual bootstrap through the dashboard, not something the agent
orchestrates. This replaces an earlier, more complex design (device-code
polling + agent-submitted email + magic links) that was solving a problem
that doesn't actually exist here — the agent doesn't need to *act as* the
person at all.

### 1. Dashboard login (person, via browser) — MSG91 proxy-auth

**Resolved 2026-08-25, replacing generic OAuth**: dashboard login uses
MSG91's hosted proxy-auth widget (`proxy.msg91.com` — MSG91's "36Blocks"
auth product), not a classic OAuth provider. See `docs/msg91-proxy-auth.md`
and `docs/auth.md` for the integration pattern this was modeled on.
Implemented in `src/lib/msg91.ts`, `src/services/msg91Login.ts`
(user + company linking), and **both** of MSG91's documented integration
shapes (`docs/msg91-proxy-auth.md` "Option A" and "Option B" — added
2026-08-27, sharing one `loginWithMsg91Token` helper in
`src/routes/auth.routes.ts`):

**Corrected 2026-08-31**: token verification is `generateAuthToken`
(`authkey` header + `proxy_auth_token` header → `{data: {jwt}}`, whose
payload carries `user`/`company` claims directly), **not**
`routes.msg91.com/api/c/getDetails` as `docs/msg91-proxy-auth.md`
originally described — that doc's pattern didn't match this account's
real API, confirmed against a live integration test. `MSG91_AUTHKEY` is
account-wide (its own JWTs carry permissions like
`create_authkey`/`delete_authkey`/`assign_permissions`) — it must only
ever be read server-side in `src/lib/msg91.ts`; if it ever appears in
frontend/browser code, treat it as compromised and rotate it in the
MSG91 dashboard. The returned JWT's payload is decoded, not
cryptographically verified — trust comes from having just fetched it
directly from MSG91 over an authkey-authenticated call, not from
checking its signature (we don't have, and don't need, MSG91's HS256
signing secret).
- `POST /auth/msg91/exchange {token}` — for a client that gets the token
  in-page (the widget's `success` callback) and POSTs it itself; returns
  the session as JSON.
- `GET /auth/msg91/callback?proxy_auth_token=...&next=/path` — for a
  client that configures the widget's `addInfo.redirect_path` to point
  here instead; MSG91 redirects the *browser* here with the token in the
  query string, so there's no JSON response to read — this sets the
  refresh cookie and 302s the browser to `next` on `FRONTEND_ORIGIN`
  (never taking the redirect's origin from the request itself — see the
  `safeRedirectPath` guard, a direct response to this doc's own security
  note about restricting redirect targets to an allowlist). The frontend
  is expected to call `POST /auth/refresh` on load to mint an access
  token from that cookie, rather than expecting one in the URL.

MSG91's
`currentCompany` on a verified identity is mapped to a hostnsoft `Company`
(`Company.msg91Id`) — the first person from a company to log in
creates the company as its `company_admin`; later logins from the same company
join as `viewer`, promotable via the existing member-role endpoint. This
still issues this API's own access/refresh tokens after verification, per
the original design intent below.

**Confirmed 2026-08-25**: a company_admin-invited member (`POST
/companies/:companyId/members`) is guaranteed to belong to the same MSG91 company
as the company they were invited into — so when they eventually log in, their
pre-existing `CompanyMembership` (with whatever role the admin picked) is
left untouched rather than being overwritten by the `viewer` default; see
`joinOrCreateCompany` in `src/services/msg91Login.ts`. Company creation
and membership creation there use create-then-catch-conflict rather than
check-then-create, specifically so two never-before-seen-company users
logging in at nearly the same time can't both "win" company creation and
crash on the unique constraint — verified with a concurrent-login test.

<details>
<summary>Superseded: original generic-OAuth framing (kept for context)</summary>

Standard OAuth login, implemented directly in this project (provider
choice — Google, GitHub, a custom OAuth2 authorization server, etc. — is
up to whoever builds this; not prescribed here, see open questions).
Once logged in, a person creates companies, invites members, and
creates/rotates/revokes company-scoped Deploy Tokens entirely through the
dashboard UI. This is the **only** login system in this project — there
is no separate agent-facing login flow.

What `hostnsoft-api` needs to support this (standard, well-trodden
territory — no bespoke design needed beyond picking a library):
- An OAuth callback endpoint that exchanges the provider's code for the
  person's identity (email, provider, provider_user_id) and finds-or-
  creates the corresponding `User`.
- Its own session issuance after that — a short-lived JWT/cookie for the
  dashboard plus a `RefreshToken` for silent renewal (same shape as
  before: `httpOnly`, `Secure` cookie for the refresh token, access token
  in memory, refreshed on page load).

</details>

### 2. Agent bootstrap — getting a deploy token, not logging in

The `hostnsoft-deploy` client-facing skill package (`SKILL.md` +
`scripts/deploy.sh` — see the ambiguity noted in
`../hostnsoft-deploy/CLAUDE.md` about exactly where this package lives
relative to the server repo of the same name) should:

1. Check for an existing stored token first — `HOSTNSOFT_TOKEN` env var,
   or a local credentials file. If found, use it directly; skip
   everything below.
2. If none exists, tell the person plainly: *"You'll need a deploy token
   — go to `https://hostnsoft.com/login`, sign in, open your company's Tokens
   page, create one, and paste it here"* (or: *"...and set it as
   `HOSTNSOFT_TOKEN` in your environment"*).
3. Wait for the person to paste the token back in chat, or confirm
   they've set the env var — there is no polling, no automatic detection
   of completion. The human closes the loop by pasting the token.
4. Persist it locally once received (same pattern discussed for general
   token persistence: a credentials file, `chmod 600`) so this only
   happens once per machine/agent context, not once per conversation.

This is the same shape the original `hostnsoft-deploy` skill already
assumed (`HOSTNSOFT_TOKEN` as a required env var) — this just adds the
missing "what do I do if I don't have one yet" guidance for a first-time
user, rather than introducing new infrastructure.

### Why this doesn't need agent-side polling or a magic-link system

The earlier design's complexity (device codes, polling, agent-submitted
email) existed to let the agent *automatically* detect when a login
completed, without the person needing to copy anything back. That's a
nice property for a *login* — but there's no login here to automate the
completion of. Copy-pasting a token is a single manual step a person does
once; building an automated-detection system for a one-time copy-paste
is solving a problem more elaborate than the actual need.

## API surface: Companies, Projects, Members, Tokens

All endpoints below assume an authenticated request (`req.user` populated
by whatever auth middleware lands later, per the deferred Auth flow
section — build this resource layer against that assumption now, wire up
real middleware afterward). Permission column uses the roles from the
data model above.

### Companies

| Endpoint | Permission | Notes |
|---|---|---|
| `POST /companies` `{name}` | any authenticated user | Creates the company; creator is automatically added as `company_admin`. |
| `GET /companies` | any authenticated user | Lists companies the current user belongs to, with their role in each. |
| `GET /companies/:companyId` | viewer+ | Company details — name, created_at, member count, project count. |
| `PATCH /companies/:companyId` `{name}` | company_admin | Rename the company. |
| `DELETE /companies/:companyId` | company_admin | **Blocked if the company has any projects** — see open questions; don't silently cascade-delete deployed apps. |

### Members

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /companies/:companyId/members` | viewer+ | Lists members, their role, and status (`invited` vs `active`). |
| `POST /companies/:companyId/members` `{email, role}` | company_admin | Invites by email. If no `User` row exists for that email yet, create one (bare shell — no OAuth identity attached until they first log in) and a `CompanyMembership` with `status: invited`. Becomes `active` automatically the first time that email completes OAuth login. |
| `PATCH /companies/:companyId/members/:userId` `{role}` | company_admin | Change a member's role. |
| `DELETE /companies/:companyId/members/:userId` | company_admin | Remove a member. **Must reject if this would leave the company with zero `company_admin`s** — see Non-functional expectations below. |

### Projects

| Endpoint | Permission | Notes |
|---|---|---|
| `POST /companies/:companyId/projects` `{name}` | company_admin or project_admin | Generates an immutable `slug` from `name` (lowercase + dashes, matching `hostnsoft-deploy`'s app-name validation) — check it's unique platform-wide before creating, since `hostnsoft-deploy` routes by subdomain (`<slug>.app.hostnsoft.com`). |
| `GET /companies/:companyId/projects` | viewer+ | Lists projects in the company. |
| `GET /companies/:companyId/projects/:projectId` | viewer+ | Project summary — current health, latest deployment, current memory allocation. (Deeper views — full deployment history, logs, resource graphs — are separate endpoints per "Required capabilities" below, not detailed here yet.) |
| `PATCH /companies/:companyId/projects/:projectId` `{name}` | company_admin or project_admin | Renames the **display name only** — `slug` never changes after creation. See open questions on why. |
| `DELETE /companies/:companyId/projects/:projectId` | company_admin or project_admin | Must also decommission the running app on `hostnsoft-deploy` (stop its Nomad job) — **`hostnsoft-deploy` has no "stop/delete an app" endpoint today**, only deploy. This is a real gap to flag as a needed change to that repo, not something to solve by deleting the DB row alone and leaving the app running orphaned. |

### Tokens (company-scoped deploy tokens)

| Endpoint | Permission | Notes |
|---|---|---|
| `POST /companies/:companyId/tokens` `{label}` | company_admin | Generates a token, returns the **plaintext secret exactly once** in this response, stores only its hash. Response: `{id, label, token, created_at}`. |
| `GET /companies/:companyId/tokens` | company_admin | Lists tokens — `{id, label, created_at, last_used_at, revoked_at}` — **never** the secret itself, not even truncated/partial, past this one-time creation response. |
| `DELETE /companies/:companyId/tokens/:tokenId` | company_admin | Revokes (sets `revoked_at`) — soft delete, keep the row for audit history. |
| `POST /companies/:companyId/tokens/:tokenId/rotate` | company_admin | Creates a replacement token under the same label, and per the earlier rotation note, should keep the old one valid for a short overlap window rather than revoking it instantly — avoids breaking an in-flight CI run. |

Conceptual rules carried over from the earlier design (still apply):
- Multiple tokens per company, each independently labeled, so revocation
  doesn't require guessing which token is which (e.g. "CI pipeline",
  "Jane's laptop").
- **Token scope is still an open question** (company-wide vs. project-scoped)
  — see open questions below; the endpoints above assume company-wide for
  now since that's the simpler migration path from `hostnsoft-deploy`'s
  current single-shared-token model.

## Required capabilities (from the person's spec)

Per project, viewable by any role with access to that project:
- **App health** — is it currently up (Nomad allocation status)
- **Deployment history** — versioned list of past deploys, each with
  outcome (success/fail), image tag, timestamp, who/what triggered it
- **Memory / CPU utilization** — current and probably historical
  resource usage
- **Logs** — application logs (source: Nomad/Docker logs for the
  allocation — decide streaming vs. paginated fetch)

Mutable, by `company_admin` or `project_admin` only:
- **Env vars** — CRUD on a project's environment variables. These need to
  actually reach the running app — likely means this service writes them
  into the Nomad job spec's `env` block and triggers a redeploy, or some
  other mechanism `hostnsoft-deploy` needs to expose. This is a real
  integration point with `hostnsoft-deploy` that needs designing, not just a
  database table.
- **Memory allocation** — override the auto-detected default (currently
  256MB / 512MB based on PGlite detection, per the gist). Needs a way to
  push this into the Nomad job spec too.

## Integration with the existing `hostnsoft-deploy`

**`hostnsoft-deploy` is a real sibling repo at `../hostnsoft-deploy/`, not
a copy — read its actual source there directly** (particularly
`server.js`, `detect-storage-usage.js`, `app-registry.js`) before
designing the integration. See `../hostnsoft-deploy/CLAUDE.md` for an
orientation to that repo's structure and known constraints.

**It is a separate git repository.** Do not edit files inside
`../hostnsoft-deploy/` while working on `hostnsoft-api` — if this
project's design requires a change there (e.g. updating a running app's
env vars via the Nomad job spec), call that out explicitly as a needed
change to a separate repo, rather than editing it in passing. It should
be reviewed and deployed to the server independently, following whatever
release process that repo uses. (Per-company-token-authenticated
deploys, below, was a deliberate exception — the user explicitly asked
for that specific cross-repo change.)

**Resolved 2026-08-26 — per-company-token-authenticated deploys**:
`hostnsoft-deploy`'s `server.js` no longer trusts a single shared
`PLATFORM_TOKEN`. It now requires an `X-Company-Id` header alongside the
`Authorization: Bearer <token>`, and confirms that pair against this
service via `POST /internal/deploy-tokens/validate`
(`src/routes/internalTokens.routes.ts`) before doing anything else. That
endpoint takes no auth of its own beyond the token itself (see its
comment for why), hashes the token, and checks it exists, isn't revoked
(honoring the rotation grace window), and belongs to the claimed company
— then stamps `DeployToken.lastUsedAt`. See
`../hostnsoft-deploy/docs/CLAUDE.md` for that repo's side.

**Routing gotcha hit while wiring this up, worth remembering**: every
resource router here (`companiesRouter`, `tokensRouter`, etc.) calls
`.use(requireAuth)` on itself with no path filter. Since all these
routers mount at `/` in `src/routes/index.ts`, that blanket check runs
for *any* request that reaches it first in mount order — not just
requests meant for that router — and 401s them before they can fall
through to a later-mounted, intentionally-unauthenticated router. Any
new no-auth route (like the internal one above) MUST be mounted before
the first `requireAuth`-applying router, or it silently 401s. See the
comment in `src/routes/index.ts`.

This is the central architectural question for this project: **does
`hostnsoft-api` extend `hostnsoft-deploy` directly, or sit as a separate
service that calls it?** Given `hostnsoft-deploy` is currently a single
trusted process with no auth model beyond one shared token, I'd lean
toward: `hostnsoft-api` is a separate service (this repo), owns the
user/company/project/token data model and all the RBAC logic, and calls
`hostnsoft-deploy` internally (or eventually replaces pieces of it) for
the actual build/deploy mechanics — rather than bolting multi-tenancy onto
a process that was designed around a single trusted caller. Confirm this
direction before architecting further; it affects nearly everything else
here.

Also relevant from the docs: `hostnsoft-deploy` already had a security
review around exposing new endpoints to public/untrusted traffic (see the
storage-shim discussion in `../docs/session-log-storage-and-security.md`
— a design was rejected specifically because it exposed the deploy-capable
process to public traffic). Whatever `hostnsoft-api` becomes publicly
reachable at, keep the same discipline: it should not itself gain the
ability to arbitrarily execute `railpack`/`nomad` commands directly — it
should call `hostnsoft-deploy`'s existing (or extended) endpoints, keeping
deploy execution capability in one place.

## Non-functional expectations

- Tokens must be stored hashed, never in plaintext, with only a prefix or
  label shown back to the user after creation (standard practice — e.g.
  GitHub PAT-style "shown once at creation, never again").
- Every mutating action (env var change, memory change, token
  create/revoke, role change) should be audit-logged: who, what, when.
- This is an API-only project — no server-rendered pages. The dashboard
  session (cookie + refresh token, from the OAuth login flow) is the one
  exception, needed for the separate dashboard frontend's browser
  session. The agent never holds a login session at all — it
  authenticates purely via a company deploy token where applicable.
- **A company must always have at least one `company_admin`.** Both removing a
  member and changing a member's role away from `company_admin` need this
  check — reject the request if it would leave zero. Otherwise a company can
  be locked out of its own management with no path back in short of
  manual database intervention.

## Open questions to resolve before/while building (don't guess silently)

1. ~~Token scope: company-wide vs. project-scoped~~ — **resolved: company-wide**
   (confirmed 2026-08-25, implemented in `src/routes/tokens.routes.ts`),
   matching `hostnsoft-deploy`'s current model.
2. How env var / memory allocation changes actually propagate to a
   running app on `hostnsoft-deploy` — new endpoints needed there.
3. Whether this repo also owns the dashboard *frontend*'s auth session, or
   purely serves as a backend the frontend calls (spec says "API only,"
   so assume the latter, but confirm the frontend's auth mechanism is
   compatible with what the OAuth callback sets — same signing key/session
   format, same cookie domain if applicable).
4. Log retrieval mechanism — pull from Nomad/Docker on demand, or ship
   logs somewhere centralized this service reads from.
5. ~~Which OAuth provider(s) to support~~ — **resolved: not classic OAuth
   at all.** Dashboard login uses MSG91's hosted proxy-auth widget
   (`proxy.msg91.com`) — see "Auth flow" #1 above, `docs/msg91-proxy-auth.md`,
   and `src/routes/auth.routes.ts`'s `POST /auth/msg91/exchange`.
6. **`project_admin` scope**: is this role company-wide (a `project_admin`
   member can manage *every* project in the company) or per-project (needs
   its own `ProjectMembership` junction table, granting access to
   specific projects only)? The API surface above assumes company-wide for
   v1 — simpler, matches the current `CompanyMembership`-only data model, no
   new table needed. Per-project scoping is a real feature some companies will
   want eventually (e.g. contractor access to one project only) but adds
   real complexity; don't build it speculatively before it's asked for.
7. **`hostnsoft-deploy` needs a "stop/decommission an app" endpoint** —
   it currently only supports deploying, never removing. `DELETE
   /companies/:companyId/projects/:projectId` in this API has nothing to call for
   that half of its job until this exists on the other repo. Flag this
   explicitly to whoever owns `hostnsoft-deploy` rather than working
   around it (e.g. by leaving orphaned Nomad jobs running after a
   project's DB row is deleted).
8. **Company deletion cascade behavior**: the API surface above blocks
   deleting a company that still has projects, rather than silently
   cascade-deleting running apps. Confirm this is the right default
   before building — the alternative (force-delete everything) is more
   convenient but much easier to trigger by accident.

## Repo conventions

- Language/framework: **Node.js + Express + TypeScript** (decided
  2026-08-25) — matches `hostnsoft-deploy`'s stack.
- Database: **SQLite via Prisma** for now (decided 2026-08-25), schema
  written to migrate cleanly to Postgres later (see `prisma/schema.prisma`
  header comment on the one SQLite-specific workaround — enums stored as
  plain strings).
- Testing approach: _still TBD — no test framework set up yet_.

See the repo's own `README.md` for the actual scaffold structure and a
list of what's intentionally stubbed vs. implemented.