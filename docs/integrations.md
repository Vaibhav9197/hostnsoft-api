# Integrations

Apps on Embarko that need Slack, Google Sheets or a CRM had to build and
host that glue themselves, and agent-built apps mostly skipped it.
Integrations gives each app viasocket's embed: its end users connect apps
and build flows inside the customer's product. Added 2026-10-23, moved to
the embed model 2026-10-24.

viasocket is the engine. **The person never needs that name**: the
feature is "Integrations", the app's env vars are `INTEGRATIONS_*`, and no
reply from this API carries a viasocket key or session. The AI building
the app does meet viasocket, through its skill; the skill and the agent
reply spell the mapping from `INTEGRATIONS_*` to the `VIASOCKET_*` names
that SDK reads.

## Shape

```
Turn on (dashboard or agent) ──▶ hostnsoft-api ──SSO login──▶ viasocket workspace (one per Embarko workspace)
                                      │            ──GET /orgs/<org>/token──▶ workspace auth key (stored)
                                      │            ──POST /orgs/<org>/projects──▶ embed project (one per app)
                                      └──▶ app env: INTEGRATIONS_ORG_ID, INTEGRATIONS_PROJECT_ID, INTEGRATIONS_SECRET

Deployed app ──signs embed token with INTEGRATIONS_SECRET──▶ loads viasocket embed in its own page
```

Two tables:

- **`IntegrationsWorkspace`** — the hidden viasocket workspace behind one
  Embarko workspace: its org id, the owner whose SSO login made it, and
  the workspace's own auth key.
- **`IntegrationsProject`** — one app's embed project id and the key it
  signs embed tokens with (`authKey`: a copy of the workspace key today;
  viasocket is moving to one key per project, and then it lives here).

## Provisioning

Lazy: a workspace that never uses Integrations never gets a viasocket
workspace. The first app that turns Integrations on creates one (`services/integrationsWorkspace.ts`):

1. Sign an SSO token (HS256, `VIASOCKET_PARTNER_KEY`) with
   `{parent_company_id, email, title, exp}` and call
   `GET /users/sso/login?token=`. One call creates the workspace and the
   user if new, and logs in. Idempotent for an existing pair.
2. `GET /orgs/<org_id>/token` with the session → the workspace's auth key.
   Stored on the row; never returned by any endpoint.

- **Title is `Embarko-<companyId>`**, never the display name. viasocket
  creates a new workspace for any title it has not seen, so a title that
  followed a renamed company would strand its flows.
- **Owner is a real person**: the member who turned it on from the
  dashboard, or on the agent path the workspace Owner (else the deploy
  token's creator). Logging in again as them is how later calls get a
  session (`sessionFor`). No email anywhere → `409 email_required`.

Turning Integrations on for an app (`services/integrationsProject.ts`):
list the workspace's embed projects, find `Embarko-<projectId>` or create
it (`POST /orgs/<org_id>/projects`, type `embed`, viasocket's default
settings), store the mapping, write the env vars. Project id, not slug:
a slug can change. Everything on viasocket's side happens before anything
is written here, so a failure leaves nothing half-done.

## What an app receives

Three env vars, written like `CRON_SECRET` and baked into the job spec on
the next deploy (or an `apply`):

| Variable | What it is |
|---|---|
| `INTEGRATIONS_ORG_ID` | The workspace's id on the engine. |
| `INTEGRATIONS_PROJECT_ID` | This app's embed project id. |
| `INTEGRATIONS_SECRET` | The workspace's auth key. Signs embed tokens. Server-side only. |

The app signs an HS256 JWT per end user with `INTEGRATIONS_SECRET`:

```json
{ "org_id": "<INTEGRATIONS_ORG_ID>", "project_id": "<INTEGRATIONS_PROJECT_ID>", "unique_identifier": "<end user id>" }
```

and loads `https://embed.viasocket.com/prod-embedcomponent.js` with
`viaSocket.mount({ embedToken, parent })`. That part is the app's.

Enable **refuses** rather than overwrites if the app already sets any of
the three itself (`409 env_var_conflict`). Static sites are refused
(`409 not_supported_for_static`). An unclaimed (anonymous) app is refused
too — it has no workspace.

Turning it off removes the env vars and flags the row (`disabledAt`).
The row and the embed project on viasocket both stay: the row is Embarko's
only record of which project is whose, and the flows in it are the
customer's work. Turning it on again clears the flag and rewrites the env
vars from the stored ids, with no call to viasocket. Nothing is removed
until the app itself is deleted (the row cascades with it). A workspace
move turns it off the same way: the project belongs to the workspace the
app left.

## Opening viasocket signed in

Two links, both built by `consoleLinkFor`: an SSO login as the signed-in
member (which creates their viasocket user in the workspace on first use)
and the session token it returns in the URL.

- `GET /companies/:id/integrations/console` → the workspace's
  integrations page, `/integrations/<org id>`. Any member, switch on.
- `GET …/projects/:projectId/integrations/console` → that app's embed
  metrics, `/integrations/<org id>/<embed project id>/embed-metrics`.
  `app.view`, app on.

`302` by default; `?format=json` answers `{url}` for the dashboard to open
in a new tab. The URL carries the session, so the response is `no-store`
with `Referrer-Policy: no-referrer`, and the link is never logged.

## Permissions

Two switches, in order:

1. **Workspace** (`Company.integrationsEnabled`, off by default). Only a
   workspace **Owner** flips it: `PUT /companies/:id/integrations
   {enabled}`; anyone else gets `403 owner_required` "Only company owners
   can enable or disable this feature." Any member may read it. Not a
   permission in `permissions.ts`: there is one switch and "Owner" is the
   whole rule. Turning it off also turns Integrations off for every app
   in the workspace (rows flagged, env vars removed, applied on each app's
   next deploy).
2. **App**: `app.view`. Once the workspace switch is on, every member may
   turn Integrations on or off for any app they can see. Refused
   with `409 integrations_disabled_for_workspace` while the workspace
   switch is off.

On the **agent path** that 409 also emails the workspace Owners
(`services/integrationsRequest.ts`): which app asked, and a link to
Settings. At most one email per app per day, read off the audit log
(`integrations.request`), so a retrying agent does not flood anyone. The
reply carries `ownersNotified` and a `next` telling the agent to wait.

A member who leaves needs no special handling. `loadCompanyContext` asks
proxy live on every request.

## Agent parity

`GET/POST/DELETE /apps/:appName/integrations`, on the same services,
authenticated with the deploy token. `{"apply": true}` pushes the running
app's config, the same contract as the env-vars agent route.

## Configuration

`VIASOCKET_PARTNER_KEY` and `VIASOCKET_PARENT_ORG_ID` gate the feature.
**Unset, every Integrations route answers `503 integrations_not_configured`**
and nothing else changes. See `.env.example`.

The partner key signs every SSO token, so anyone holding it can sign in as
any email under Embarko's viasocket workspace. Same handling as
`PROXY_ADMIN_TOKEN`: server-side only, never logged, never returned. Each
workspace's own auth key is a secret too, but a leak costs that one
workspace, and it reaches apps as an env var by design.

### Onboarding checklist

1. Get the key from the viasocket dashboard (Embed → "Get your key"). Set
   `VIASOCKET_PARTNER_KEY` and `VIASOCKET_PARENT_ORG_ID`.
2. Turn Integrations on for one internal app and confirm the workspace
   appears on viasocket as `<parent org>-Embarko-<id>` with one embed
   project `Embarko-<projectId>`.

## Known gaps

- **Secret rotation.** The workspace auth key is one per workspace;
  viasocket documents no rotate call. If it leaks, ask viasocket.
- **A departed member keeps their viasocket user.** Our side denies them
  at the door; viasocket documents no remove-user call.
- **Single instance.** The provisioning guard is in-process; a second
  instance could still race a first open. Same constraint
  `scheduleRunner.ts` already has.
