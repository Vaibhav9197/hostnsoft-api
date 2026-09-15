# Embarko Documentation

## [Overview](#overview)

Embarko deploys apps from source to a live URL, and gives each company a
dashboard/API to manage what's running: environment variables, memory
allocation, deployment history, rollback, and custom domains.

**Most day-to-day management — env vars, memory, rollback, custom domains,
monitoring, deleting a project — happens directly in the dashboard**
(`https://embarko.ai/app`), and that's what the sections below walk
through. Deploying itself always goes through the **Deploy API**
(`https://ship.embarko.ai/apps...`) — there's no separate
upload-through-the-dashboard flow, so this is what an agent, CI pipeline,
or your own script uses to actually ship code.

Everything the dashboard does is also available directly as a **Platform
API** (`https://ship.embarko.ai/api/...`) for anyone building their own
tooling instead of using the dashboard — not the focus of this doc, since
it walks through the dashboard, but it exists if you want it.

A few things that apply everywhere below:
- **Projects auto-create on first deploy.** No dashboard step is required
  beforehand — the first deploy of a new app name creates its project under
  your token's company automatically.
- **App names are unique platform-wide**, not just within your company — an
  app name is also its live subdomain (`<app-name>.app.embarko.ai`). If
  another company already used the exact name you're deploying,
  `code: "app_name_taken"`.
- **Every non-2xx response has a `code` field.** Branch on `code`, not on the
  human-readable `error` string, which can change without notice. Full list
  in [`troubleshoot.md`](troubleshoot.md).

For every error/edge case and known platform constraint, see
[`troubleshoot.md`](troubleshoot.md) — this doc only covers the happy path.

## [Quick start](#quick-start)

**1. Get a deploy token** — see [Authentication](#authentication).

**2. Package and deploy:**

```bash
tar -czf /tmp/my-app.tar.gz --exclude=node_modules --exclude=.git -C /path/to/app .

curl -X POST "https://ship.embarko.ai/apps" \
  -H "Authorization: Bearer $DEPLOY_TOKEN" \
  -H "X-App-Name: my-app" \
  -H "X-App-Version: $(git rev-parse --short HEAD)" \
  -F "source=@/tmp/my-app.tar.gz"
```

You'll get a `202` immediately — the build/deploy itself continues in the
background:

```json
{ "accepted": true, "statusUrl": "https://ship.embarko.ai/apps/my-app/status", "logsUrl": "https://ship.embarko.ai/apps/my-app/logs" }
```

**3. Poll until it's live:**

```bash
curl "https://ship.embarko.ai/apps/my-app/status" -H "Authorization: Bearer $DEPLOY_TOKEN"
```

Wait for `deploy.status` to be `"success"` (or `"failed"` — check `.../logs`
if so). Once successful, your app is live at `https://my-app.app.embarko.ai`.
Full details on both endpoints: [Checking deploy status & logs](#status-and-logs).

## [Your app's requirements](#your-apps-requirements)

- **Listen on `process.env.PORT`**, bound to `0.0.0.0` — not a hardcoded port,
  not `127.0.0.1`/`localhost` only.
- **No Dockerfile needed** — the platform builds your app with
  [Railpack](https://railpack.com), which auto-detects your language/runtime
  from your source (Node, Python, etc.).
- **Anything that needs to survive a redeploy must live under `DATA_DIR`**
  (an env var the platform provides) — a fresh container is scheduled on
  every redeploy, and only `DATA_DIR` persists across that. See
  [`limitations-and-recommendations.md`](limitations-and-recommendations.md#only-data_dir-survives-a-redeploy)
  for the full explanation and a concrete example of getting this wrong.
- **Don't use `window.storage`** — a Claude Artifacts sandbox API that
  doesn't exist here. Use SQLite (`better-sqlite3`) or PGlite
  (`@electric-sql/pglite`) under `DATA_DIR` instead.

## [Capabilities](#capabilities)

`GET https://ship.embarko.ai/capabilities` — the machine-readable version of
this page's constraints. No authentication, cached for an hour, and safe to
read before you have a token.

It answers the questions you need settled *before* writing an app: the
runtime contract (`PORT`, `0.0.0.0`, no Dockerfile), what survives a
redeploy and what doesn't, how to obtain a credential, the memory defaults,
and which features exist. Each feature also says **who can invoke it** —
some are dashboard-only today, so an agent can tell in advance whether it
can do a thing itself or has to hand it to a person.

```json
{
  "runtime": { "port_env": "PORT", "bind_address": "0.0.0.0", "dockerfile": "rejected" },
  "persistence": { "data_dir_env": "DATA_DIR", "survives_redeploy": true, "survives_node_loss": false },
  "features": {
    "deploy":   { "status": "available", "via": ["agent", "dashboard"] },
    "rollback": { "status": "available", "via": ["dashboard"] },
    "backups":  { "status": "unavailable" }
  }
}
```

Anything reported `"unavailable"` is genuinely not built — don't design
around it.

## [Authentication](#authentication)

Every deploy is authenticated one of two ways:

### [Deploy tokens](#deploy-tokens)

```
Authorization: Bearer <token>
```

1. Go to `https://embarko.ai/login` and sign in (or create an account).
2. Open your company's **Deploy tokens** page (`https://embarko.ai/app/tokens`).
3. Enter a label (e.g. `"CI pipeline"`) and click **Create token** — shown
   once, prefixed `emb_`, and cannot be retrieved again. (Tokens issued
   before the Embarko rename start `hns_` and remain valid — there's no
   need to rotate them.)
4. `export DEPLOY_TOKEN="..."` (or store it in a local credentials file,
   e.g. `~/.embarko/credentials`, `chmod 600`).

**By email, no browser needed** — the route to prefer when an AI agent is
doing the work, since it needs nothing but an email address:

```bash
curl -X POST "https://ship.embarko.ai/api/public/deploy-tokens/request" \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com"}'
```

Always returns `202` — the token is emailed, never returned in the
response, and an account and company are created automatically if that
address doesn't have one. Rate limited per-email, per-IP and globally.

**Rotating/revoking**: from the same page, **Rotate** issues a replacement
under the same label — the old token keeps working for **one hour**
afterward so an in-flight CI run doesn't break. **Revoke** disables a token
immediately. Because tokens are stored hashed and shown only once, **Rotate
is also how you recover a token you've lost** — there is no way to read an
existing one back.

Deploy tokens are company-wide (not scoped to one project) and authenticate
deploys only — they don't sign in to the dashboard itself.

### [Anonymous (no token) deploys](#anonymous-deploys)

Omit the `Authorization` header entirely to deploy without an account first —
useful for trying the platform before committing to one. This creates an
**unclaimed ("orphan") project** that:
- Gets a `24h` expiry — after that, the app and its container image are
  torn down automatically.
- Shows a live countdown banner injected into the app's own pages (HTML apps
  only — see [`troubleshoot.md`](troubleshoot.md#the-in-app-will-be-deleted-banner-doesnt-show-up)).
- Can be **claimed** at any point before expiry by redeploying the exact same
  `X-App-Name` **with** a valid token — this cancels the expiry and the
  project behaves like any other project from then on, with no trace of
  having been anonymous.

A present-but-invalid token is always a hard `401`, never silently treated
as anonymous — only a completely absent header opts into this path.

## [Deploying / redeploying](#deploy)

`POST /apps` (same endpoint for the first deploy and every redeploy after —
just upload new source under the same `X-App-Name`):

| Header | Required | Notes |
|---|---|---|
| `Authorization` | no | `Bearer <token>` — omit for an anonymous deploy |
| `X-App-Name` | yes | lowercase letters/numbers/dashes only, unique platform-wide |
| `X-App-Version` | no | defaults to a timestamp; pass a git SHA or semver tag for a meaningful history — never reuse a version tag for different code |

Body: multipart, field `source`, a `.tar.gz` of your app's source.

```bash
curl -X POST "https://ship.embarko.ai/apps" \
  -H "Authorization: Bearer $DEPLOY_TOKEN" \
  -H "X-App-Name: my-app" \
  -H "X-App-Version: v1.2.0" \
  -F "source=@/tmp/my-app.tar.gz"
```

Redeploying picks up your **current** env vars and memory allocation (see
below) automatically — you don't need to resend them.

## [Checking deploy status & logs](#status-and-logs)

These live on the **deploy API** (`ship.embarko.ai`), not the platform
API — same host as `POST /apps`, so an agent or script that only ever talks
to the deploy API (never the dashboard) can still check on its own deploy
without a separate set of credentials.

**Auth model, same for both**: while a project is still an unclaimed
("orphan") anonymous deploy, no token is needed at all — anyone can check
it. Once claimed, a token for the owning company is required; a missing or
wrong one gets a `404` (never confirming the app exists to a caller who
doesn't own it), not a `401`.

### [Status](#status)

```bash
curl "https://ship.embarko.ai/apps/my-app/status" -H "Authorization: Bearer $DEPLOY_TOKEN"
```

```json
{
  "appName": "my-app",
  "deploy": {
    "status": "success",
    "appVersion": "v1.2.0",
    "startedAt": "2026-09-09T10:00:00.000Z",
    "finishedAt": "2026-09-09T10:01:32.000Z",
    "errorDetail": null
  },
  "health": { "...": "live status of the running app" }
}
```

`deploy.status` is `"in_progress"`, `"success"`, or `"failed"` — this is
what `POST /apps`'s `statusUrl` is for: poll this after the `202`
until it's no longer `"in_progress"`. `deploy` reflects the **most recent
deploy attempt this process has seen** (in-memory, not a durable history —
see your project's **Deployments** tab in the dashboard, or
[Monitoring your app](#monitoring) below, for durable history). `health`
reflects the app's actual current running state, independent of the last
deploy's outcome.

### [Logs](#logs)

```bash
curl "https://ship.embarko.ai/apps/my-app/logs" -H "Authorization: Bearer $DEPLOY_TOKEN"
curl "https://ship.embarko.ai/apps/my-app/logs?stream=stderr" -H "Authorization: Bearer $DEPLOY_TOKEN"
```

```json
{ "available": true, "allocId": "b457e652-...", "stream": "stdout", "logs": "...tail of recent output..." }
```

`?stream=stderr` is optional (default `stdout`). This is a **snapshot of
the tail of the most recent allocation's logs at the moment you call it**
— not a live stream — poll it if you need to watch output as it happens.
Always the most recent allocation regardless of whether it's currently
healthy, since the most common reason to check logs is a build/runtime
failure. If nothing's deployed yet: `{"available": false, "reason": "No
allocation has ever been created for this app yet"}`.

## [Environment variables](#environment-variables)

Set through the dashboard, then **redeploy** — env vars are baked into the
app's configuration at deploy time, they don't reach an already-running
container on their own (see
[`troubleshoot.md`](troubleshoot.md#env-var-changes-need-a-redeploy-to-reach-the-running-app)):

1. Open your project in the dashboard and go to its **Environment
   Variables** section.
2. Add, edit, or remove a variable (key/value) — keys must match
   `^[A-Za-z_][A-Za-z0-9_]*$`.
3. Click **Save**.
4. **Redeploy** the app — saving alone only stores the change; the running
   app only picks up new values on its next deploy. If you don't have new
   code to ship, redeploy your current source again as-is.

## [Memory allocation](#memory-allocation)

Default is 256MB (512MB if an embedded DB like PGlite is auto-detected).

1. Open your project in the dashboard and go to its **Memory** section.
2. Enter the new limit in MB and save.

This only **persists** the new value — it takes effect on the next deploy,
rollback, or custom-domain change, not immediately. If you don't have a new
build to ship, the fastest way to apply a memory change alone is rolling
back to the **current** version (see below) — that re-applies the configuration
with no rebuild.

## [Rollback](#rollback)

One click, no rebuild — reruns a past successful build's image under the
current config (current env vars and custom domains, not whatever they were
at the time of that old deploy):

1. Open your project's **Deployments** history in the dashboard.
2. Find the past successful deployment you want.
3. Click **Rollback** next to it.

You'll see it confirmed right away, but **applying it takes a little
while** — same as a regular deploy, switching the app over isn't instant.
The dashboard shows this deployment as **in progress** until it's done,
then updates to **success** (or **failed**, if something went wrong
applying it — rare, since the one common failure mode, the old image
being gone, is caught immediately, before it's even confirmed as
started).

Only deployments that succeeded are valid targets. Rolling back
creates a **new** deployment history entry pointing at the old image — it
doesn't rewrite history. See
[`troubleshoot.md`](troubleshoot.md#rollback-target-image-unavailable) if the
target image was cleaned from the host.

## [Custom domain mapping](#custom-domains)

Point your own domain at a deployed app, instead of (or alongside) its
default `<app-name>.app.embarko.ai` URL.

1. Open your project in the dashboard, go to **Custom Domains**, and enter
   your domain (e.g. `app.yourdomain.com`).
2. You'll see the exact DNS record to create. A **subdomain** (like
   `app.yourdomain.com`) gets a `CNAME` to a dedicated platform hostname. An
   **apex/root domain** (`yourdomain.com`, no subdomain) can't use `CNAME`
   under standard DNS rules — you'll get an `A` record to the platform's
   origin IP instead, which means it bypasses any CDN/proxy you'd normally
   put in front of it (see
   [`troubleshoot.md`](troubleshoot.md#apex-root-domains-lose-your-cdnproxy-in-front-of-them)).
3. Create that exact DNS record with your DNS provider. If using
   Cloudflare, make sure it's set to **DNS only** (grey cloud), not
   **Proxied** (orange cloud) — a proxied record will never verify, see
   [`troubleshoot.md`](troubleshoot.md#verify-stuck-on-not-resolving-yet-despite-a-correct-looking-record).
4. Click **Verify** — safe to click repeatedly until DNS propagates.
   Routing only activates once this confirms DNS actually resolves
   correctly — nothing is activated at step 1.
5. Once active, the domain shows status **Active** in the same **Custom
   Domains** list.

**Removing a domain** (click **Remove** next to it) tears down just that
domain's routing/certificate — your app's default `*.app.embarko.ai` URL is
never affected.

Custom domains require port 80 reachable for certificate issuance — see
[`troubleshoot.md`](troubleshoot.md#custom-domain-activation-requires-port-80-reachable)
if verification never completes despite correct DNS.

## [Customer queries: feature requests & feedback](#feature-requests)

Send a feature request, feedback, or another kind of query. Three ways to
send one, depending on who's sending it — a message is required either way
(max 5000 characters).

### [From the dashboard (logged in)](#feature-requests-dashboard)

Open **Feedback** (or **Send feedback**) in the dashboard, choose
**Feature**, **Feedback**, or **Other**, write your message, and submit.
Your account email is attached automatically — you never need to enter it.

### [From an AI agent, while deploying](#feature-requests-agent)

For an agent (Claude Code, ChatGPT, whatever) to report feedback about the
app it's actively deploying, without needing dashboard credentials at all —
same auth as `.../status`/`.../logs` (a token is required once the app is
claimed, optional while it's still an anonymous orphan):

```bash
curl -X POST "https://ship.embarko.ai/apps/my-app/customer-query" \
  -H "Authorization: Bearer $DEPLOY_TOKEN" \
  -H "X-Agent-Name: Claude Code" \
  -H "Content-Type: application/json" \
  -d '{"type": "feedback", "message": "Deploy docs did not mention DATA_DIR clearly enough"}'
```

`X-Agent-Name` is required — free text, so any current or future agent can
identify itself without needing a platform change to be recognized. Note
this one is on the **deploy API** host (`ship.embarko.ai`, no `/api` prefix)
— it's the same host `POST /apps` uses, unlike the other two paths here.

### [Anonymous, no account at all](#feature-requests-public)

```bash
curl -X POST "https://ship.embarko.ai/api/public/customer-query" \
  -H "Content-Type: application/json" \
  -d '{"type": "feedback", "message": "...", "email": "you@example.com"}'
```

Rate-limited (per-email, per-IP, and globally — see
[`limitations-and-recommendations.md`](limitations-and-recommendations.md#public-unauthenticated-endpoints-are-rate-limited))
since it requires no authentication at all.

## [Monitoring your app](#monitoring)

Open your project in the dashboard:
- **Overview** — current health, latest deployment, and memory allocation
  at a glance.
- **Deployments** — full deployment history.
- **Logs** — recent output from the app (a snapshot, not a live stream —
  see
  [`limitations-and-recommendations.md`](limitations-and-recommendations.md#logs-are-a-recent-snapshot-not-a-live-stream)).
- **Analytics** — traffic and resource usage over a chosen range (`24h`,
  `7d`, `30d`, `90d`, or `all`).

## [Deleting a project](#deleting-a-project)

Open your project in the dashboard, go to **Settings**, and click **Delete
project**.

Tears down the running app (its container, routing, and image) as
well as the dashboard record — this is not reversible.

## [Errors and known limitations](#errors)

See [`troubleshoot.md`](troubleshoot.md) for the full error-code reference,
and [`limitations-and-recommendations.md`](limitations-and-recommendations.md)
for the platform's actual constraints (persistence, memory/CPU/disk,
network isolation, logs, rate limits) paired with concrete recommendations
for each — worth reading once before you build something that assumes
guarantees the platform doesn't make.
