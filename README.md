# hostnsoft-api

Multi-tenant management API — users, companies, projects, deploy tokens, env
vars, deployment history — sitting in front of the existing
`hostnsoft-deploy` service. See `docs/CLAUDE.md` for the full project
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
  the agent never logs in as a person; it only ever uses a
  manually-bootstrapped company Deploy Token. See `docs/CLAUDE.md` "Auth flow",
  `docs/msg91-proxy-auth.md`, and `docs/auth.md` for the full reasoning.

## Setup

```bash
npm install
cp .env.example .env          # fill in JWT_SECRET at minimum
npm run prisma:migrate -- --name init
npm run dev                    # http://localhost:4100
```

No live MSG91 widget/token to test against? Mint a local session without
one: `npm run dev:session -- you@example.com` prints an access token you
can use directly against every other route.

## Structure

```
src/
├── server.ts              entry point
├── app.ts                 express app assembly (helmet, cors w/ credentials, cookies)
├── lib/                   prisma client, JWT (access token), refresh tokens,
│                          deploy-token hashing, slug generation
├── middleware/             requireAuth, loadCompanyContext, requireRole, errorHandler
├── services/               audit log writer, company-admin-floor check
├── routes/                one file per resource (auth, companies, projects, tokens, ...)
└── types/                 Role union, Express Request augmentation
```

Request pipeline for a company/project-scoped route:
`requireAuth` → `loadCompanyContext` (loads the caller's `CompanyMembership` for
`:companyId`) → `requireRole(minimum)`.

## Auth flow implemented here

Two independent things, per `docs/CLAUDE.md`:

1. **Dashboard login (human, browser)** — MSG91 proxy-auth
   (`docs/msg91-proxy-auth.md`). The dashboard frontend (a separate repo)
   embeds MSG91's widget and gets back a `proxy_auth_token`; it sends
   that to `POST /auth/msg91/exchange {token}` here. This API:
   - verifies the token against MSG91 (`src/lib/msg91.ts`, calls
     `routes.msg91.com/api/c/getDetails`) — never trusts it unverified;
   - finds-or-creates the local `User` keyed by `msg91Id`, falling back
     to linking by email for a member a company_admin invited before their
     first login (`src/services/msg91Login.ts`);
   - **maps MSG91's `currentCompany` to a hostnsoft `Company`**
     (`Company.msg91Id`): first person from that company creates the
     company as `company_admin`; later logins from the same company join as
     `viewer` (promotable via the existing member-role endpoint);
   - activates any `invited` memberships for that email;
   - issues this API's own short-lived access token (response body) plus
     an httpOnly refresh-token cookie. `POST /auth/refresh` rotates it;
     `POST /auth/logout` revokes it.
2. **Agent bootstrap** — not implemented here at all, deliberately. The
   agent-side `hostnsoft-deploy` skill package is responsible for telling
   a first-time user to create a token via this dashboard and paste it
   back; this API only needs to support token CRUD (`src/routes/tokens.routes.ts`),
   which it does.

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
- **Deployment recording** (`deployments.routes.ts`) — `POST
  .../deployments/record` has nothing calling it yet; `hostnsoft-deploy`
  has no webhook/callback today, so whether this API polls it or gets
  pushed to is still open.
- **Live health / logs** — `GET .../projects/:id` returns `health:
  "unknown"`; there's no log retrieval endpoint yet (open question #4:
  pull from Nomad/Docker on demand vs. a centralized log sink).
- **`project_admin` scope** (open question #6) — currently company-wide, per
  the data model (`CompanyMembership` only, no per-project grant table).
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
