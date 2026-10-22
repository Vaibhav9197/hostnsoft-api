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

## Billing

Lago owns plans/customers/subscriptions (customer `external_id` = proxy
company id); Stripe is called directly only to list payment methods. Nothing
billing-related is stored locally. See `docs/billing.md`.

## Data model / hierarchy

**Resolved 2026-09-04: users, companies and membership live on MSG91 proxy,
not here.** There is no `User`, `Company` or `CompanyMembership` table. Every
`userId` / `companyId` column is a plain string holding the *proxy* id, with no
foreign key. See `docs/plans/2026-09-04-001-refactor-proxy-owned-identity-plan.md`.

```
[MSG91 proxy]  User ──member of──▶ Company          (owned by proxy; read via src/lib/msg91.ts)
                │                     │
                │ userId              │ companyId   (proxy ids, plain strings here)
                ▼                     ▼
                                    DeployToken (label, created_at, revoked_at, last_used_at)
                                    Project — one deployed app on hostnsoft-deploy
                                      ├─ slug (the identifier hostnsoft-deploy uses;
                                      │   app-name convention: lowercase + dashes.
                                      │   Changeable, at real cost — see the slug
                                      │   endpoint below; not immutable as it once was)
                                      ├─ name (mutable display name, independent of slug)
                                      ├─ Deployments (versioned history — one row per attempt)
                                      ├─ EnvVars (key/value, scoped to the project)
                                      ├─ Schedules → ScheduleRuns (timed GET calls into the app;
                                      │   docs/schedules.md, added 2026-10-17)
                                      └─ current resource allocation (memory; cpu once enforced)
 AuditLog (actorUserId, companyId, projectId — all plain strings)
```

**Authorization is membership-only.** Proxy exposes no readable per-user role
(verified against four working proxy integrations and MSG91's docs on
2026-09-04 — the decoded JWT carries `user`/`company` only, the membership API
returns a count, invites take an email only). So this API has no roles either:
any member of a company may do anything in it — manage deploy tokens, projects,
env vars. The earlier `company_admin | project_admin | viewer` model, which
this doc had flagged as "first pass, confirm before building", was removed.

A user can belong to multiple companies; which one a request targets is always
the `:companyId` in the URL, checked against proxy membership per request.

## Auth flow (simplified — two separate, independent concerns)

**The agent never logs in as the person, and never holds a session on
their behalf.** It only ever needs one thing: a company-scoped **Deploy
Token** (already specced below). Getting that token the first time is a
one-time bootstrap, now via any of three paths: through the dashboard;
by the agent calling the open, rate-limited
`POST /public/deploy-tokens/request {email}` (**added 2026-09-08**), which
emails the person a **new deploy token** for every company they belong to
(creating the proxy user and a company named after the email first when
none exist) — the response is always the same 202 so the endpoint never
confirms which emails have accounts (see
`docs/plans/2026-09-08-001-feat-email-deploy-token-api-plan.md` and
`src/services/publicTokenRequest.ts`); or — **added 2026-09-11** — by an AI
client (a ChatGPT/Claude "connector") exchanging a `proxy_auth_token` for
one via `POST /connector/token`, see "3. AI-connector bootstrap" below.
This replaces an earlier, more complex design (device-code polling +
agent-submitted email + magic links) that was solving a problem that
doesn't actually exist here — the agent doesn't need to *act as* the
person at all.

### 1. Dashboard login (person, via browser) — MSG91 proxy-auth

**Resolved 2026-08-25, replacing generic OAuth**: dashboard login uses
MSG91's hosted proxy-auth widget (`proxy.msg91.com` — MSG91's "36Blocks"
auth product), not a classic OAuth provider. See `docs/msg91-proxy-auth.md`
and `docs/auth.md` for the integration pattern this was modeled on.
Implemented in `src/lib/msg91.ts`, `src/middleware/companyContext.ts`
(per-request proxy membership check), and **both** of MSG91's documented integration
shapes (`docs/msg91-proxy-auth.md` "Option A" and "Option B" — added
2026-08-27, sharing one `loginWithMsg91Token` helper in
`src/routes/auth.routes.ts`):

**Corrected 2026-08-31**: token verification is `generateAuthToken`
(`authkey` header + `proxy_auth_token` header → `{data: {jwt}}`, whose
payload carries `user`/`company` claims directly), **not**
`routes.msg91.com/api/c/getDetails` as `docs/msg91-proxy-auth.md`
originally described — that doc's pattern didn't match this account's
real API, confirmed against a live integration test. `PROXY_ADMIN_TOKEN` is
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
  in-page (the widget's `success` callback) and POSTs it itself; verifies
  the token and returns the user + current company as JSON.
- `GET /auth/msg91/callback?proxy_auth_token=...&next=/path` — for a
  client that configures the widget's `addInfo.redirect_path` to point
  here instead; MSG91 redirects the *browser* here with the token in the
  query string, so there's no JSON response to read — this verifies the
  token (bad logins surface as `?auth_error=...`) and 302s the browser to
  `next` on `FRONTEND_ORIGIN` (never taking the redirect's origin from the
  request itself — see the `safeRedirectPath` guard, a direct response to
  this doc's own security note about restricting redirect targets to an
  allowlist).

**Changed 2026-09-04**: login creates *nothing* locally. **Changed
2026-09-05**: this API no longer issues its own session either — the local
JWT access token, `RefreshToken` table, refresh cookie, and
`POST /auth/refresh` are all gone. The `proxy_auth_token` (PAT) from the
MSG91 widget *is* the session credential; its lifetime and revocation are
proxy's. The exchange response returns proxy's `currentCompany` for
convenience; the full company list is `GET /companies`.

**The dashboard must keep the `proxy_auth_token` after login** and send it as
the `proxy_auth_token` header on **every** authenticated request —
`src/middleware/proxyToken.ts` (`requireProxyToken`) is the sole auth guard
for human routes, verifying the PAT against proxy (cached in
`src/lib/msg91.ts`). The redirect (callback) flow deliberately does not
forward the PAT — a frontend using it takes the PAT from the proxy embed it
already hosts.

**Company switching** (`POST /auth/switch-company {companyId}`) exists only so
the company-aware proxy embed on the dashboard agrees with what the dashboard
shows. This API never reads "current company" — scope is the URL's
`:companyId`, checked against proxy membership on every request — so the
switch updates nothing local; it calls proxy's `switchCompany` and writes an
audit row.

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

1. Check for an existing stored token first — `DEPLOY_TOKEN` env var
   (renamed from `HOSTNSOFT_TOKEN` as part of the Embarko rebrand — see
   `hostnsoft-skill/`), or a local credentials file. If found, use it
   directly; skip everything below.
2. If none exists, tell the person plainly: *"You'll need a deploy token
   — go to `https://embarko.ai/app/tokens`, sign in, create one, and paste it
   here"* (or: *"...and set it as
   `DEPLOY_TOKEN` in your environment"*).
3. Wait for the person to paste the token back in chat, or confirm
   they've set the env var — there is no polling, no automatic detection
   of completion. The human closes the loop by pasting the token.
4. Persist it locally once received (same pattern discussed for general
   token persistence: a credentials file, `chmod 600`) so this only
   happens once per machine/agent context, not once per conversation.

This is the same shape the original `hostnsoft-deploy` skill already
assumed (`DEPLOY_TOKEN` as a required env var) — this just adds the
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

### 3. AI-connector bootstrap — one-click via ChatGPT/Claude

**This changed once Embarko could be listed as a connector inside
ChatGPT/Claude (added 2026-09-11).** An MCP/connector client *can* run a
real one-click login — the AI client opens MSG91's hosted login widget in
a system browser, the person logs in exactly as they would on the
dashboard, and the widget hands the AI client a `proxy_auth_token`
in-page, the same credential the dashboard's own "Option B" integration
uses (`docs/msg91-proxy-auth.md`). **The login page itself is entirely
MSG91 proxy's — out of scope for this API**, same as dashboard login. What
this API adds is the two REST endpoints an AI client needs around that
login, both in `src/routes/connectorAuth.routes.ts`, neither behind
`requireProxyToken` (their credential arrives in the request body, not the
header):

- `POST /connector/token {token}` — "the token endpoint": exchanges the
  `proxy_auth_token` the widget just produced for a company-scoped Deploy
  Token, scoped to the identity's *current* company (same company proxy's
  JWT names on login — see `POST /auth/msg91/exchange`). Mints a brand-new
  token every call (same non-rotating shape as `mintEmailToken`, see
  `src/services/connectorToken.ts`) rather than reusing one, so
  reconnecting never invalidates a still-in-use token. Stored with
  `DeployToken.source = "connector"` — a third value alongside
  `"dashboard"` and `"agent"` (`src/lib/deployTokens.ts`) — so it shows up
  distinctly in `GET /companies/:companyId/tokens` and is revocable from
  the dashboard like any other token. A person with no current company
  (proxy normally auto-creates one on first login) gets a `409` telling
  them to finish setup on the dashboard, not a token to nowhere.
- `POST /connector/token/validate {token}` — "the token-validation API":
  given a Deploy Token (from this endpoint, the dashboard, or the public
  email endpoint — all the same row type), reports `{valid, companyId,
  companyName, tokenId, label, lastUsedAt}`, or `{valid: false}`.
  Deliberately **not** the same route as
  `POST /internal/deploy-tokens/validate` — that one is reserved for
  `hostnsoft-deploy`'s own server-to-server calls and is flagged in its own
  comment for eventual network-level restriction to `hostnsoft-deploy`'s
  host; this one is meant for the open internet (an AI platform's backend
  introspecting a token it's holding), so it also resolves `companyName`
  via proxy rather than leaving the caller with only an opaque id.

Both routes are public (mounted in the no-`requireProxyToken` block in
`src/routes/index.ts` — see that file's routing-gotcha comment) and each
carries its own per-IP rolling rate limit
(`src/lib/connectorTokenConfig.ts`, `CONNECTOR_TOKEN_*` env vars) — the
exchange endpoint's window guards against retry storms from a
misbehaving client rather than credential guessing (it already requires a
live `proxy_auth_token`); the validate endpoint's window guards a route
now reachable by anyone on the internet, even though the token itself
(a 256-bit secret) isn't practically guessable.

This doesn't add a new token type or a new capability an agent can do
that it couldn't before — a connector-sourced Deploy Token is used
exactly like any other Deploy Token against `hostnsoft-deploy`. It only
removes the one manual step (copy a token out of the dashboard, paste it
somewhere) by giving an AI client a way to get that same token itself,
once a person has completed the same MSG91 login they'd do anyway.

## API surface: Companies, Projects, Members, Tokens

All endpoints below require a valid `proxy_auth_token` header
(`requireProxyToken`). Every
`/companies/:companyId/...` route then runs `loadCompanyContext`, which asks
proxy whether the caller is a member of that company (cached ~60s, positives
only) and 404s otherwise. "any member" in the Permission column means exactly
that — there are no roles (see Data model).

### Companies

Creating, renaming and deleting companies, and all member management
(invite, remove), happen through the **proxy embed on the dashboard** — none of
it has an endpoint here (removed 2026-09-04).

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /companies` | any authenticated user + `proxy_auth_token` header | Lists companies the current user belongs to, straight from proxy (user-key call). |
| `GET /companies/:companyId` | any member | Company details from proxy — id, name — plus local project count. |
| `PATCH /companies/:companyId` `{name?, email?, meta?, timezone?, timeZoneName?}` | any member | Partial update, forwarded to proxy `PUT /c/updateCompany`. Proxy acts on the PAT's *current* company, requires `name` + `email` every call, and replaces `meta` wholesale — so the route switches the PAT to `:companyId` if needed, fills omitted fields from the current record (email falls back to the caller's), and merges `meta` key-wise. A changed name is also pushed to the Lago and Stripe customers, best effort. Proxy 422 surfaces as `400 PROXY_INVALID_INPUT` with proxy's message. |
| `POST /auth/switch-company` `{companyId}` | any member + `proxy_auth_token` header | Moves proxy's current company for this user so the embed matches the dashboard. Nothing local changes. Audited as `company.switch`. |

### Projects

| Endpoint | Permission | Notes |
|---|---|---|
| `POST /companies/:companyId/projects` `{name}` | any member | Generates a `slug` from `name` (changeable later, see the slug endpoint) (lowercase + dashes, matching `hostnsoft-deploy`'s app-name validation) — check it's unique platform-wide before creating, since `hostnsoft-deploy` routes by subdomain (`<slug>.embarko.app`). |
| `GET /companies/:companyId/projects` | any member | Lists projects in the company. |
| `GET /companies/:companyId/projects/:projectId` | any member | Project summary — current health, latest deployment, current memory allocation. (Deeper views — full deployment history, logs, resource graphs — are separate endpoints per "Required capabilities" below, not detailed here yet.) |
| `PATCH /companies/:companyId/projects/:projectId` `{name}` | any member | Renames the **display name only** — never touches `slug`. |
| `PATCH /companies/:companyId/projects/:projectId/slug` `{slug}` | any member | Changes the app's **web address**. Takes the slug literally (no slugifying) and applies the full claim policy: charset, length, hyphen placement, and the reserved list — the latter with **no** grandfathering, unlike `services/projectClaim.ts`, since a rename is always a new claim. Two paths: an app that has never deployed is one UPDATE; a live one is a real migration delegated to `hostnsoft-deploy`'s `POST /internal/apps/:appName/rename` (stop job → move data dir → retag images → run new job → **wait for a fresh certificate** → purge old job → carry analytics over). That takes minutes, and nothing in front of this service will hold a request that long — the dashboard's BFF proxy aborts at 10s — so a live move answers **`202 {moving, from, to, statusUrl}`** and continues behind the response; poll **`GET /companies/:companyId/projects/:projectId/slug`** for the outcome — always `200 {state: in_progress|succeeded|failed|unknown, currentSlug, appUrl, ...}`, the same resolver the agent surface polls. In-progress state is in-memory only, same reasoning as `hostnsoft-deploy`'s `deploy-status.js` — see `services/renameStatus.ts`, including what it costs if this service is ever run multi-instance — but a *finished* move is also recoverable from the audit log, so `succeeded` survives a restart and the 30-minute in-memory expiry. `unknown` means no record of a move, never "no such app"; every state carries `currentSlug` so a caller never has to infer where the app actually is. A second PATCH while one is running is `409 rename_in_progress`. The new slug is written here only after the migration succeeds. Live renames are rate-limited to one per `SLUG_CHANGE_COOLDOWN_MS` (default 7d, read off the audit log) because each spends a certificate from the zone's weekly Let's Encrypt budget — see open question 8. The **database-only path is not rate-limited**, since it orders no certificate; that is why the two paths audit under different actions (below). Codes: `400 invalid_app_name`/`app_name_too_short`/`app_name_too_long`; `409 app_name_reserved`/`app_name_taken`/`deploy_in_progress`/`no_current_deployment` (running but no record of which image is live — redeploy first); `429 slug_change_cooldown`; `503 app_state_unknown` (can't reach `hostnsoft-deploy` to check — fails closed); `502 rename_failed` (migration refused/rolled back, app untouched); `500 rename_desynced` (the app moved but the name was claimed here mid-migration — needs a human). Re-sending the current slug is a no-op. **The old address dies immediately** — no redirect. Since 2026-10-21 the old name is kept as a `SlugAlias` row for the app: nobody else can claim it, and a deploy or agent call under it reaches the renamed app (`services/projectClaim.ts` `resolveDeployTarget`, `slugChangeFlow.ts` `findRenamedApp`). Deploys can also send the app's stable id (`X-App-Id`, or `appId` in embarko.json), which wins over the name. **Also available to agents** at `POST /apps/:appName/slug-change` (see the agent control plane below); this was dashboard-only until 2026-09-21, on the grounds that a company-wide deploy token meant one agent could strand every other agent and CI job holding the old name. That reasoning did not survive examination — it describes the slug, not the caller, and a person clicking rename here strands them just as completely. What made it safe on both surfaces was making stranding non-terminal: a caller arriving on a name that has moved now gets `404 app_renamed` carrying the new name and a retry URL, rather than `app_not_found`. Audited as `project.slug_change` for the database-only path and `project.slug_change_live` for the migration, with `(agent:<token label>)` appended to the detail when an agent did it. The split is what keeps the cooldown honest: it reads **only** the live action, so renaming a never-deployed app and then deploying it does not lock its address for a week over a move that spent nothing. Readers that only care *that* it moved (the status resolver, the `app_renamed` lookup) match both. Neither is filtered by actor, so the cooldown is shared across the dashboard and agent surfaces and one cannot be used to reset the other. The orchestration is `services/slugChangeFlow.ts`, shared by both routes; `services/projectSlugChange.ts` keeps the policy and mechanics. |
| `DELETE /companies/:companyId/projects/:projectId` | any member | Must also decommission the running app on `hostnsoft-deploy` (stop its Nomad job) — **`hostnsoft-deploy` has no "stop/delete an app" endpoint today**, only deploy. This is a real gap to flag as a needed change to that repo, not something to solve by deleting the DB row alone and leaving the app running orphaned. |

### Tokens (company-scoped deploy tokens)

| Endpoint | Permission | Notes |
|---|---|---|
| `POST /companies/:companyId/tokens` `{label}` | any member | Generates a token, returns the **plaintext secret exactly once** in this response, stores only its hash. Response: `{id, label, token, created_at}`. |
| `GET /companies/:companyId/tokens` | any member | Lists tokens — `{id, label, created_at, last_used_at, revoked_at, source}` (`source` is `dashboard`, `agent`, or `connector` — minted in the UI, by the public email endpoint, or by an AI connector exchange) — **never** the secret itself, not even truncated/partial, past this one-time creation response. |
| `DELETE /companies/:companyId/tokens/:tokenId` | any member | Revokes (sets `revoked_at`) — soft delete, keep the row for audit history. |
| `POST /companies/:companyId/tokens/:tokenId/rotate` | any member | Creates a replacement token under the same label, and per the earlier rotation note, should keep the old one valid for a short overlap window rather than revoking it instantly — avoids breaking an in-flight CI run. |
| `POST /connector/token` `{token}` | none (public) — `token` is a live `proxy_auth_token`, not a header | "The token endpoint" (Auth flow #3 above): exchanges a `proxy_auth_token` for a new Deploy Token scoped to the identity's current company. `source: "connector"`. Response: `{accessToken, tokenId, label, companyId, companyName, createdAt}`. `409 {error: "no_company"}` if the identity has no current company yet. |
| `POST /connector/token/validate` `{token}` | none (public) — `token` is a Deploy Token | "The token-validation API" (Auth flow #3 above): `{valid: true, companyId, companyName, tokenId, label, lastUsedAt}` or `{valid: false}`. Separate from the internal `/internal/deploy-tokens/validate` used by `hostnsoft-deploy` — this one is meant for the open internet and resolves a human-readable `companyName`. |

**Public email endpoint tokens (added 2026-09-08).** There is no special
"default" token. Each `POST /public/deploy-tokens/request` mints a brand-new
ordinary token per company (label `email <timestamp> UTC`, see
`src/services/emailToken.ts`) and never rotates or revokes anything, so a
service still deploying with an older token keeps working. Members revoke
unwanted ones from the dashboard like any other token.

**AI-connector tokens (added 2026-09-11).** Same non-rotating shape:
`POST /connector/token` always mints a brand-new token (label
`Connector Token: <time> IST`, see `src/services/connectorToken.ts`),
never touching any existing token. See Auth flow #3 above for the full
exchange + validate flow.

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

Mutable, by any company member:
- **Env vars** — CRUD on a project's environment variables. These need to
  actually reach the running app — likely means this service writes them
  into the Nomad job spec's `env` block and triggers a redeploy, or some
  other mechanism `hostnsoft-deploy` needs to expose. This is a real
  integration point with `hostnsoft-deploy` that needs designing, not just a
  database table.
  - **Static apps have no env vars.** Since 2026-09-24 `Project.kind`
    (`"service"` | `"static"`, a string so further kinds can be added)
    records how an app is deployed. `hostnsoft-deploy` reports `kind` on
    the success call to `POST /internal/deployments/record`; the dashboard
    hides the env-var and memory controls when it is `"static"`. Since
    2026-09-29 the API also refuses env-var writes/applies and memory
    changes for a static project with `409 not_supported_for_static`
    (`src/middleware/refuseForStaticApp.ts`, dashboard and agent routes);
    reads and deletes still work.
- **Memory allocation** — override the platform default (256MB for every
  app; the old 512MB PGlite tier was removed when PGlite support was
  dropped). Note this value is the task's burst *ceiling* (`memory_max`),
  not its reservation — deploy-service schedules against a much lower
  universal 32MB floor that `Project.memoryMb` deliberately does not
  affect, so raising memory buys headroom without making the app harder
  to place.

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

**Resolved 2026-09-13 — claimed-app status/logs also accept a
proxy_auth_token**: `GET /apps/:appName/status`, `.../logs`, and
`.../customer-query` on `hostnsoft-deploy` (all three share one
`authorizeAppAccess` helper — see that repo's `server.js`) used to accept
only a deploy token for a claimed app. Rather than building a parallel
API for a logged-in dashboard user to check their own app, that SAME
helper now also accepts the dashboard's own `proxy_auth_token` as an
alternative — checked against the SPECIFIC company the app belongs to via
a new `POST /internal/proxy-auth/verify-membership`
(`src/routes/internalProxyAuth.routes.ts`), since (unlike a deploy token)
a PAT isn't itself scoped to one company. Gated by `requireInternalSecret`
— not just "the token itself is the credential" like
`/internal/deploy-tokens/validate` — since a PAT is a far more powerful
credential than a company-scoped deploy token. An orphan app is
unaffected (still no credential needed at all); a deploy token still
takes precedence when both are somehow presented, so no existing
agent/CI caller's behavior changes. See
`../hostnsoft-deploy/verify-proxy-auth.js` for that repo's side.

**Resolved 2026-09-17 — `POST /apps` (the deploy itself) also accepts a
proxy_auth_token**: the dashboard is growing an upload button, and a
logged-in person holds a PAT and nothing else. Rather than making them
mint a company-wide deploy token just to press it — a stronger, longer-
lived secret created for a worse reason — the SAME `POST /apps` endpoint
now takes a PAT as an alternative credential, exactly as status/logs did
above. Since a PAT isn't company-scoped, the caller also sends
`X-Company-Id`, and this service *verifies* that pairing (proxy
membership) rather than trusting hostnsoft-deploy's word for it. Both
internal endpoints a deploy passes through — `POST /internal/projects/claim`
and `POST /internal/deployments/record` — now accept
`{proxyAuthToken, companyId}` in place of `{token}`, resolved by one
shared helper (`src/services/deployActor.ts`) so the three credential
paths can't drift apart. That helper demands `X-Internal-Secret` on the
PAT branch only, leaving the deploy-token and anonymous branches
untouched; a deploy token still wins when both are somehow presented, so
no existing agent/CI caller changes. **The anonymous/orphan path is
deliberately unchanged** — only a request with NO credential at all
deploys anonymously; a PAT that's present and fails is a 401/403, never a
silent downgrade. `hostnsoft-deploy`'s own side shipped the same day (its
new `deploy-credential.js` mirrors `deployActor.ts` — change them
together; plus `cors()` for the first browser caller that service has
ever had). The orphan banner needed nothing: it's a sidecar keyed off
`claim.isOrphan`, not a build-time injection keyed off "has a token".
Full contract in `docs/Ui-upload-deploy-req.md`.

**Resolved 2026-10-08 — an orphan can be kept by a claim link, not only
by redeploying with a token.** The deploy that creates an orphan mints a
one-time claim code (`src/lib/orphanClaim.ts`; 32 random bytes, only its
SHA-256 kept in `Project.claimCodeHash`) and `POST /internal/projects/claim`
returns it once, inside `claimUrl` (`<FRONTEND_ORIGIN>/claim?app=…&code=…`),
which hostnsoft-deploy relays as the deploy reply's `links.claim`. The
dashboard's `/claim` page signs the person in (the MSG91 widget does
sign-up too), has them pick or create a company, and calls
`POST /companies/:companyId/orphans/claim {appName, code}`
(`src/routes/projects.routes.ts`): verify the hash in constant time, move
the project into the company with `updateMany({isOrphan: true})` so two
claimants can't both win, clear every orphan field, then `applyCurrentConfig`
re-pushes the running image without the banner — no rebuild. Wrong code,
unknown name, expired and already-claimed are all the same 404, so a name
alone reveals nothing. The token-redeploy adopt path still works and also
clears `claimCodeHash`. Two consequences worth knowing: (1) **anonymous
deploys are now recorded** in `/internal/deployments/record` (`triggeredBy:
"anonymous"`), accepted only while the project is still an orphan, because
the re-push needs the recorded image tag — an orphan without a usable row
(pre-dating this, or whose record call failed) is still claimed, and the
reply says `bannerClearsOn: "next_deploy"`; (2) the code is never minted on
an anonymous *re*deploy of an existing orphan, or anyone who guessed the
name could obtain one. Spec: `docs/Anonymous-deploy-req.md` ("Claim link").

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
- This is an API-only project — no server-rendered pages, no cookies. The
  dashboard authenticates every request with its MSG91 `proxy_auth_token`.
  The agent never holds a login session at all — it authenticates purely
  via a company deploy token where applicable.
- ~~A company must always have at least one `company_admin`.~~ **Moot since
  2026-09-04** — there are no roles, and membership is managed on proxy via
  the dashboard embed, so "locked out of its own management" can't happen on
  this side. Whether proxy protects its own last owner is proxy's concern.

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
6. ~~**`project_admin` scope**~~ — **moot 2026-09-04**: roles were removed
   entirely (proxy has none to read; see Data model). Any member can manage
   any project in the company. If per-project or per-role access is ever
   wanted, it would need a new local grant table keyed by proxy ids — don't
   build it speculatively.
7. **`hostnsoft-deploy` needs a "stop/decommission an app" endpoint** —
   it currently only supports deploying, never removing. `DELETE
   /companies/:companyId/projects/:projectId` in this API has nothing to call for
   that half of its job until this exists on the other repo. Flag this
   explicitly to whoever owns `hostnsoft-deploy` rather than working
   around it (e.g. by leaving orphaned Nomad jobs running after a
   project's DB row is deleted).
8. ~~**Renaming a LIVE app**~~ — **built.** `hostnsoft-deploy` now has
   `POST /internal/apps/:appName/rename` (`rename-app.js`), called from
   `src/services/appRename.ts`. The sequence and the reasoning below are
   what it implements; kept here because the two constraints that drive
   the ordering are not obvious from the code alone. **Not yet exercised
   against real Nomad/Docker/ACME — must be run on a throwaway app in the
   test environment before any real app uses it.** That is still true now
   that agents can trigger it too: the migration is the same code either
   way, so testing it once covers both callers, but it has not been done.

   Two interlocks were missing and have been added alongside the agent
   endpoint (2026-09-21). The rename path already refused to start while
   a deploy was in flight, but nothing refused the converse: a rollback
   or env-var apply could push to a Nomad job the migration was tearing
   down (now guarded in `services/redeploy.ts`'s `pushWithImage`, which
   both entry points funnel through), and — worse — a deploy claiming the
   name the migration was moving TO would create a SECOND project on it,
   since no project holds that name until the migration succeeds. The
   migration's own final update then failed the unique constraint and
   reported `rename_desynced`, the one outcome that needs a person. Both
   are reachable from the dashboard-only feature as it shipped; the agent
   endpoint only makes them likelier, because "rename, then deploy" is a
   natural agent sequence within the same minute. Original note follows.

   Making it work needed a new internal endpoint on `hostnsoft-deploy`
   (nothing there could rename:
   `POST /internal/apps/:appName/config` under a new name would start a
   SECOND Nomad job on a new, empty data directory while the old one kept
   serving, and `DELETE /internal/apps/:appName` deletes the data
   directory and every image, so it can't be reused either). The sequence
   that repo's code actually demands: stop the old job → move
   `$APP_DATA_ROOT/<old>` → re-tag `<old>:<ver>` images → run the new job
   → **wait for a valid certificate on the new hostname** → purge the old
   job → rewrite `app_name` in both analytics tables → move the
   `deploy-status` map entry. Roll back by moving the data directory back
   if any step fails.

   **Verified 2026-09-18 — the platform zone has NO wildcard certificate.**
   Checked against Certificate Transparency and a live TLS handshake:
   every app holds its own single-name Let's Encrypt cert
   (`CN=<slug>.app.embarko.ai`, one SAN). The `*.embarko.ai` cert that
   exists is Cloudflare's universal cert and, being single-label, does
   not cover `<slug>.app.embarko.ai`. Consequences for the above: each
   rename spends a certificate from the zone's weekly issuance budget —
   the same budget new signups draw on — and the new hostname serves
   Traefik's self-signed default (a hard browser warning) until the order
   completes. Hence "wait for the cert before purging the old job", and
   hence a per-app cooldown. **DNS, by contrast, IS a wildcard** — a
   never-before-seen `*.app.embarko.ai` name already resolves to the
   origin — so a rename needs no DNS work at all.
9. **Company deletion cascade behavior**: the API surface above blocks
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