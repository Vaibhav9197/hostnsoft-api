# hostnsoft-api

Multi-tenant management API — projects, deploy tokens, env vars, deployment
history, scoped to companies whose users and membership live on MSG91 proxy —
sitting in front of the existing `hostnsoft-deploy` service. See `docs/CLAUDE.md` for the full project
brief and open architectural questions; read it before extending this
scaffold.

## Stack

- Node.js + Express + TypeScript
- Prisma + SQLite (`prisma/schema.prisma`) — swappable to Postgres later
  by changing the `datasource` provider/URL; the schema was written with
  that migration in mind (the one SQLite-only workaround, storing enums
  as plain strings, is noted at the top of the schema file).
- Deploy tokens are **company-wide** (confirmed decision — see
  `docs/CLAUDE.md` "Open questions" #1).
- Auth is **dashboard-only, via MSG91 proxy-auth** (`proxy.msg91.com`) —
  the agent never logs in as a person; it only ever uses a company Deploy
  Token, bootstrapped either from the dashboard or via the open
  `POST /public/deploy-tokens/request {email}` endpoint, which emails a
  freshly created token per company (existing tokens are never touched). See `docs/CLAUDE.md` "Auth flow",
  `docs/msg91-proxy-auth.md`, and `docs/auth.md` for the full reasoning.


## Setup

```bash
npm install
cp .env.example .env          # fill in PROXY_* and INTERNAL_API_SECRET at minimum
npm run prisma:migrate -- --name init
npm run dev                    # http://localhost:4100
```

There is no local session or JWT: every dashboard request carries the MSG91
`proxy_auth_token` header, so testing needs a real PAT from the widget and
`PROXY_ADMIN_TOKEN` / `PROXY_*` set.

## Structure

```
src/
├── server.ts              entry point
├── app.ts                 express app assembly (helmet, cors w/ credentials, cookies)
├── lib/                   prisma client, JWT (access token), refresh tokens,
│                          deploy-token hashing, slug generation, msg91.ts (the
│                          MSG91 proxy client + in-process TTL cache)
├── middleware/             requireAuth, loadCompanyContext (proxy membership),
│                          requireProxyToken (PAT for user-key proxy calls), errorHandler
├── services/               audit log writer, deploy-token auth, project claim
├── routes/                one file per resource (auth, companies, projects, tokens, ...)
└── types/                 Express Request augmentation
```

Request pipeline for a company-scoped route:
`requireAuth` → `loadCompanyContext` (asks MSG91 proxy whether the caller is a
member of `:companyId`; cached ~60s, positives only; 404 if not). There are
no roles — any member may do anything in the company. Any route that *also*
has a `:projectId` param needs `loadProjectContext` too (after
`loadCompanyContext`) — see the security note below.

## Auth flow implemented here

Two independent things, per `docs/CLAUDE.md`:

1. **Dashboard login (human, browser)** — MSG91 proxy-auth
   (`docs/msg91-proxy-auth.md`). The dashboard frontend embeds MSG91's
   widget; the widget itself needs a `referenceId` (from MSG91/36Blocks'
   own dashboard for this account — not something this API issues or
   stores) passed into `window.initVerification({ referenceId, ... })`,
   entirely client-side. Once MSG91 hands back a `proxy_auth_token`, two
   ways to reach this API, both sharing the same `loginWithMsg91Token`
   logic in `src/routes/auth.routes.ts`:
   - **`POST /auth/msg91/exchange {token}`** — the widget's `success`
     callback fires in-page with the token; the frontend POSTs it itself
     and reads the session back as JSON.
   - **`GET /auth/msg91/callback?proxy_auth_token=...&next=/path`** — the
     widget's `addInfo.redirect_path` points here instead; MSG91 redirects
     the *browser*, so this responds with a redirect (to `next`, always
     rooted at `FRONTEND_ORIGIN` — see `safeRedirectPath`, an
     open-redirect guard, never the request's own origin), not JSON. The
     refresh cookie is still set on this response; the frontend should
     call `POST /auth/refresh` on load to get an access token rather than
     expecting one in the URL.

   Either way, this API:
   - verifies the token against MSG91 (`src/lib/msg91.ts`, calls
     `generateAuthToken` with the account-level `PROXY_ADMIN_TOKEN` — **server-side
     only**, never expose that key to a browser — and decodes the returned
     JWT's `user`/`company` claims) — never trusts the widget's token
     unverified;
   - creates **nothing** locally — there is no user or company table; the
     proxy user id becomes the subject of our session;
   - issues this API's own short-lived access token plus an httpOnly
     refresh-token cookie. `POST /auth/refresh` rotates it; `POST
     /auth/logout` revokes it.

   The dashboard must **keep the `proxy_auth_token`** it got from the widget:
   `GET /companies` and `POST /auth/switch-company` act as the user against
   proxy and need it back in a `proxy_auth_token` header
   (`src/middleware/proxyToken.ts` also checks it belongs to the same user as
   the bearer token). Company create/rename/delete and member management are
   done through the proxy embed, not this API.
2. **Agent bootstrap** — not implemented here at all, deliberately. The
   agent-side `hostnsoft-deploy` skill package is responsible for telling
   a first-time user to create a token via this dashboard and paste it
   back; this API only needs to support token CRUD (`src/routes/tokens.routes.ts`),
   which it does.

## Internal endpoints (service-to-service, not for end users)

- **`POST /internal/deploy-tokens/validate`** (`src/routes/internalTokens.routes.ts`)
  — `{companyId, token}` → `{valid: boolean}`. Called by `hostnsoft-deploy`
  on every `POST /apps` to confirm the deploy request's `X-Company-Id` +
  `Authorization` token pair is live (exists, not revoked, belongs to that
  company) before it spends any build resources.
- **`POST /internal/deployments/record`** (`src/routes/internalDeployments.routes.ts`)
  — `{companyId, token, projectSlug, appVersion, status, imageTag?,
  memoryMb?, errorDetail?}` → the created `Deployment` row. Called by
  `hostnsoft-deploy` once a deploy attempt concludes (success or failure) —
  this is what actually populates `GET .../projects/:projectId/deployments`.
  Re-validates the token independently (via the shared
  `findLiveDeployToken` in `src/services/deployTokenAuth.ts`) rather than
  trusting that hostnsoft-deploy already checked it once. Auto-creates the
  `Project` row on first sight of a given `(companyId, slug)` pair, since
  real deploys often happen via CLI/skill before anyone's touched the
  dashboard — race-safe via create-then-catch-conflict, since two
  concurrent first-deploys of a brand-new project is a real scenario
  (parallel CI jobs), not a hypothetical.
  `triggeredBy` is set server-side from the token's own `label`, not
  trusted from the request body.

  **`version` vs `appVersion`** — deliberately two different fields.
  `appVersion` is whatever hostnsoft-deploy used for the image tag (the
  client's `X-App-Version`, or its own timestamp fallback) — informational
  only, **not unique**, since a user can redeploy without ever bumping it.
  `version` (`"v1"`, `"v2"`, ...) is this API's own per-project sequence
  number, assigned server-side and never client-supplied — that's what's
  actually DB-unique per project (`@@unique([projectId, version])`),
  computed race-safely the same create-then-catch-conflict way as the
  project auto-create above.

Both internal endpoints have no `requireAuth` of their own — the raw
deploy token itself is the credential. Mounted **before** any router that
calls `.use(requireAuth)` on itself (see the comment in
`src/routes/index.ts`) — mounting either later would get it silently
401'd by an earlier router's blanket auth check, since all routers here
mount at `/`.

## Security fix — cross-tenant project access (2026-08-27)

Every `:projectId`-scoped route used to look projects up by bare `id`
(`prisma.project.update({ where: { id: req.params.projectId } })`, etc.)
with no check that the project actually belonged to `:companyId`. A
a member of **any** company could
read, rename, delete, or read/write the env vars of **any other**
company's project just by knowing or guessing a project id — env vars
included real secrets in the shape shown in this doc's examples. Fixed
with a new `loadProjectContext` middleware (`src/middleware/projectContext.ts`)
that 404s unless the project belongs to the already-resolved company;
applied to every route in `projects.routes.ts`, `envVars.routes.ts`, and
`deployments.routes.ts` that takes a `:projectId`. Verified with a live
cross-tenant exploit attempt (a second company trying to read/rename a
first company's project and env vars) — all three now 404 correctly.

## Deliberately unresolved / stubbed (see docs/CLAUDE.md for why)

Marked with `TODO` comments at their exact location rather than silently
implemented, per the project brief's "don't guess silently":

- **Env var / memory propagation** (`envVars.routes.ts`,
  `projects.routes.ts`) — changes persist in this service's DB only; they
  don't yet reach the running app on `hostnsoft-deploy`. Needs a new
  endpoint in that repo (a separate git repo — do not edit it from here)
  to push an updated Nomad job spec and redeploy.
- **Project decommissioning** (open question #7) — `DELETE
  /companies/:companyId/projects/:projectId` deletes the DB row only;
  `hostnsoft-deploy` has no stop/decommission endpoint yet, so the
  underlying Nomad job is left running, orphaned, until that exists.
- **Live health / logs** — `GET .../projects/:id` returns `health:
  "unknown"`; there's no log retrieval endpoint yet (open question #4:
  pull from Nomad/Docker on demand vs. a centralized log sink).
- **Per-role / per-project access** — none. Proxy exposes no readable roles,
  so any company member can manage every project, env var and deploy token
  in it. A finer model would need a new local grant table keyed by proxy ids.
- **Orphaned rows on proxy-side company delete** — nothing tells this API
  when a company is deleted on proxy; its `Project`/`DeployToken` rows stay,
  and existing deploy tokens keep working. Needs a webhook or reconciliation.
- **`app-registry.js`** on `hostnsoft-deploy` still exists as its own
  stopgap — this API's `Project`/`Deployment` tables are meant to
  eventually absorb it, but no migration/backfill from that JSON file has
  been written.

## Known infra gaps this API should account for, not paper over

Per `../docs/session-log-storage-and-security.md`: CPU limits, disk
quota, and network isolation between deployed apps are **not** fully
enforced at the `hostnsoft-deploy` layer yet. Don't build UI/API that
implies these are hard guarantees (e.g. a "CPU limit" field should be
labeled as a request/target until `cpu_hard_limit` is confirmed set).
