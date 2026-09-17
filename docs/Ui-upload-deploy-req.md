# Requirement: Deploy From the Dashboard UI (proxy_auth_token deploys)

**Status:** implemented 2026-09-17 on **both** sides — this repo, and
`../hostnsoft-deploy/` (a separate git repo, released independently; see
its own `docs/CLAUDE.md`). Verified end to end against the two services
running together: anonymous, deploy-token, and every proxy_auth_token
rejection path. The one path that can't be exercised without a live MSG91
session — a **valid** PAT deploying under a company it belongs to — is
unverified end to end; both halves of it are, individually.

## Purpose

`POST /apps` (on `ship.embarko.ai`) can only be authenticated with a
company **deploy token** — a credential that exists for agents, CI and
the CLI. The dashboard is about to grow an **upload** button: pick a
folder/zip, deploy it, watch it build. A person already logged into the
dashboard is holding a `proxy_auth_token` (PAT) and nothing else, so with
only the deploy-token path they'd have to detour through the Tokens page
and mint a long-lived company-wide secret just to use the button in front
of them — a worse credential, created for a worse reason, and then left
lying around.

So: the **same** `POST /apps` endpoint additionally accepts a PAT. Not a
parallel deploy API for the dashboard — the same endpoint, same upload
shape, same response, same build pipeline, one more accepted credential.
This is the exact move already made for `GET /apps/:appName/status` and
`.../logs` on 2026-09-13 (see `docs/CLAUDE.md`), applied to the deploy
path itself.

## Behavior summary

| `POST /apps` presents | Company the app is deployed under | Changed? |
|---|---|---|
| `Authorization: Bearer <deploy token>` | the token's own company | **unchanged** |
| `proxy_auth_token` + `X-Company-Id` | the named company, **after** confirming the PAT's owner is a member of it | **new** |
| Both | the deploy token's company — the deploy token wins, the PAT is ignored | **new** (precedence rule) |
| Neither | none — anonymous/orphan path | **unchanged** |
| A present-but-invalid credential of either kind | `401` | **unchanged** in spirit: only *absence* opts into anonymous |

## Functional requirements

### 1. The orphan/anonymous path is untouched

Non-negotiable, and the reason the credential resolution is written as
one shared helper rather than sprinkled through each endpoint: a request
with **no credential at all** must still create/redeploy an orphan
project with a 24h expiry, the injected banner, and the `orphan` block in
the response, exactly as `docs/Anonymous-deploy-req.md` specifies. A PAT
that's present and fails (expired, or its owner isn't a member of
`X-Company-Id`) is a `401`/`403`, **never** a silent fallback to
"deploy anonymously instead" — same rule that already applies to a bad
deploy token, and for the same reason: that would mask a real auth bug as
a feature, and quietly hand the person a temporary app they think is
permanent.

### 2. Why `X-Company-Id` is required with a PAT

A deploy token is minted per-company and carries its own `companyId`, so
it alone answers "which company". A PAT does not — a person can belong to
several companies, and the dashboard already knows which one the user is
looking at. So the company comes from the request, and hostnsoft-api
**verifies** it rather than trusting it (see #3). Sending `X-Company-Id`
with a *deploy token* changes nothing: the token's own company still
wins, so a stale header can never re-point a token-authenticated deploy at
another company.

### 3. hostnsoft-api verifies, hostnsoft-deploy relays

hostnsoft-deploy does **not** decide whether a PAT is valid or whether
its owner belongs to the company. It passes both through to
hostnsoft-api, which verifies the PAT against MSG91 proxy and checks
membership, and answers with the resolved company or an error to relay.
That keeps every identity decision in the service that owns identity.

## What hostnsoft-deploy must change

Two calls it already makes on every deploy gain optional fields.

### `POST /internal/projects/claim` (before the build)

```jsonc
{
  "slug": "my-app",

  // Path A — unchanged:
  "token": "<deploy token>",

  // Path B — new. Sent INSTEAD of `token`, both fields together:
  "proxyAuthToken": "<the PAT from the incoming request>",
  "companyId": "<the X-App-Company / X-Company-Id from the incoming request>"

  // Path C — anonymous: none of the three, exactly as today.
}
```

**`X-Internal-Secret: <INTERNAL_API_SECRET>` is required on path B** (and
only path B). hostnsoft-deploy already holds that secret and already
sends it to `POST /internal/proxy-auth/verify-membership`. The deploy-
token and anonymous paths do not need it and are unaffected — nothing
about an existing call has to change to keep working.

The rationale is the one `internalProxyAuth.routes.ts` already records: a
PAT is the credential that drives the whole dashboard, far more powerful
than a company-scoped deploy token, so relaying one requires proof of
being hostnsoft-deploy — whereas for a deploy token, knowing the raw
token simply *is* the credential.

Success response is unchanged (`projectId`, `slug`, `memoryMb`,
`customDomains`, `envVars`, `isOrphan`, orphan fields). New error
responses to relay:

| Status | Body `code` | Meaning |
|---|---|---|
| `401` | — | Missing/wrong `X-Internal-Secret` on a PAT call |
| `401` | `PROXY_TOKEN_REJECTED` | The PAT is expired or invalid — send the person back through login |
| `400` | `company_id_required` | A `proxyAuthToken` arrived without a `companyId` |
| `403` | `not_a_company_member` | Valid PAT, but its owner isn't in that company |
| `409` | — | App name taken by a different company (unchanged) |

### `POST /internal/deployments/record` (deploy start, then conclusion)

Same three fields, same internal-secret rule. `token` is now optional in
the schema, but this endpoint still needs *a* company: a call with no
credential at all is `401`, since anonymous deploys deliberately record
no history (`docs/Anonymous-deploy-req.md`, out of scope list) — that is
unchanged behavior, just now expressed as a `401` rather than a schema
rejection.

Send the **same** credential here that was sent to `.../claim` for the
same deploy. Mixing them (claim with a PAT, record with a token) isn't
rejected — both resolve to a company — but the resulting history row
would be attributed to the wrong actor.

### `POST /apps` itself

- The PAT comes from the `proxy_auth_token` header (a raw header, not
  `Authorization: Bearer` — the dashboard's own convention everywhere
  else) and the company from `X-Company-Id`. Both are read by the new
  `deploy-credential.js`, which is the deploy-side mirror of this repo's
  `src/services/deployActor.ts`; change the two together.
- Deploy token takes precedence when both are present, matching
  `authorizeAppAccess`'s existing rule for status/logs.
- **The orphan banner needed no change at all.** It is not a build-time
  injection: it's a sidecar proxy (`orphan-proxy/`, wired up in
  `nomad-job-spec.js`) included only when `claim.isOrphan` comes back
  true. A PAT deploy claims under a real company, so that flag is already
  false and the sidecar is already omitted — nothing keys off "has a
  token" any more.
- **CORS** — done: `cors()` in `server.js`, driven by a new
  `FRONTEND_ORIGIN` env var (comma-separated allowlist). The dashboard is
  this service's first *browser* caller, so without it the preflight fails
  before the upload ever reaches auth. Agents, CI and the CLI send no
  `Origin` header and are unaffected.

## Explicitly out of scope

- **No upload endpoint on hostnsoft-api.** The tarball goes to
  `ship.embarko.ai` directly, as it always has. Putting a multipart proxy
  in front of the deploy service would double the bytes on the wire and
  give this API a build-adjacent capability it deliberately doesn't have
  (see `docs/CLAUDE.md` on keeping deploy execution in one place).
- **No change to the agent-facing docs** (`hostnsoft/content/docs/`).
  A PAT is a dashboard session credential; an agent has no way to hold
  one and no reason to. Deploy tokens remain the documented way to deploy
  from outside the browser.
- **No rate limiting on PAT deploys** — consistent with the other
  internal endpoints, and tracked as the same known gap.
