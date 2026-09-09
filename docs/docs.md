# Embarko Documentation

## [Overview](#overview)

Embarko deploys apps from source to a live URL, and gives each company a
dashboard/API to manage what's running: environment variables, memory
allocation, deployment history, rollback, and custom domains.

Two APIs work together:
- **Deploy API** (`https://ship.hostnsoft.com`) — the low-level "take this
  tarball, build it, run it" service. This is the only thing an agent or CI
  pipeline needs to call to ship code.
- **Platform API** (`https://api.hostnsoft.com` — replace with your actual
  API host) — companies, projects, deploy tokens, env vars, memory, rollback,
  custom domains. This is what a dashboard (or a script managing an app after
  it's deployed) calls.

A few things that apply everywhere below:
- **Projects auto-create on first deploy.** No dashboard step is required
  beforehand — the first deploy of a new app name creates its project under
  your token's company automatically.
- **App names are unique platform-wide**, not just within your company — an
  app name is also its live subdomain (`<app-name>.app.hostnsoft.com`). If
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

curl -X POST "https://ship.hostnsoft.com/apps" \
  -H "Authorization: Bearer $DEPLOY_TOKEN" \
  -H "X-App-Name: my-app" \
  -H "X-App-Version: $(git rev-parse --short HEAD)" \
  -F "source=@/tmp/my-app.tar.gz"
```

You'll get a `202` immediately — the build/deploy itself continues in the
background:

```json
{ "accepted": true, "statusUrl": "https://ship.hostnsoft.com/apps/my-app/status", "logsUrl": "https://ship.hostnsoft.com/apps/my-app/logs" }
```

**3. Poll until it's live:**

```bash
curl "https://ship.hostnsoft.com/apps/my-app/status" -H "Authorization: Bearer $DEPLOY_TOKEN"
```

Wait for `deploy.status` to be `"success"` (or `"failed"` — check `.../logs`
if so). Once successful, your app is live at `https://my-app.app.hostnsoft.com`.

## [Your app's requirements](#your-apps-requirements)

- **Listen on `process.env.PORT`**, bound to `0.0.0.0` — not a hardcoded port,
  not `127.0.0.1`/`localhost` only.
- **No Dockerfile needed** — the platform builds your app with
  [Railpack](https://railpack.com), which auto-detects your language/runtime
  from your source (Node, Python, etc.).
- **Anything that needs to survive a redeploy must live under `DATA_DIR`**
  (an env var the platform provides) — a fresh container is scheduled on
  every redeploy, and only `DATA_DIR` persists across that. See
  [`troubleshoot.md`](troubleshoot.md#your-data-will-be-wiped-on-every-redeploy-unless-its-under-data_dir)
  for the full explanation and a concrete example of getting this wrong.
- **Don't use `window.storage`** — a Claude Artifacts sandbox API that
  doesn't exist here. Use SQLite (`better-sqlite3`) or PGlite
  (`@electric-sql/pglite`) under `DATA_DIR` instead.

## [Authentication](#authentication)

Every deploy is authenticated one of two ways:

### [Deploy tokens](#deploy-tokens)

```
Authorization: Bearer <token>
```

1. Go to `https://hostnsoft.com/login` and sign in (or create an account).
2. Open your company's **Deploy tokens** page (`https://hostnsoft.com/app/tokens`).
3. Enter a label (e.g. `"CI pipeline"`) and click **Create token** — shown
   once, prefixed `hns_`, and cannot be retrieved again.
4. `export DEPLOY_TOKEN="..."` (or store it in a local credentials file,
   e.g. `~/.embarko/credentials`, `chmod 600`).

**Rotating/revoking**: from the same page, **Rotate** issues a replacement
under the same label — the old token keeps working for **one hour**
afterward so an in-flight CI run doesn't break. **Revoke** disables a token
immediately.

Deploy tokens are company-wide (not scoped to one project) and authenticate
deploys only — they don't sign in to the dashboard itself.

### [Anonymous (no token) deploys](#anonymous-deploys)

Omit the `Authorization` header entirely to deploy without an account first —
useful for trying the platform before committing to one. This creates an
**unclaimed ("orphan") project** that:
- Gets a `24h` expiry — after that, the app, its Nomad job, and its Docker
  image are all torn down automatically.
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
curl -X POST "https://ship.hostnsoft.com/apps" \
  -H "Authorization: Bearer $DEPLOY_TOKEN" \
  -H "X-App-Name: my-app" \
  -H "X-App-Version: v1.2.0" \
  -F "source=@/tmp/my-app.tar.gz"
```

Redeploying picks up your **current** env vars and memory allocation (see
below) automatically — you don't need to resend them.

## [Environment variables](#environment-variables)

Set/update env vars through the platform API, then **redeploy** — env vars
are baked into the app's job spec at deploy time, they don't reach an
already-running container on their own (see
[`troubleshoot.md`](troubleshoot.md#env-var-changes-need-a-redeploy-to-reach-the-running-app)):

```bash
# 1. Set them
curl -X PUT "https://api.hostnsoft.com/companies/$COMPANY_ID/projects/$PROJECT_ID/env-vars" \
  -H "proxy_auth_token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"vars":[{"key":"STRIPE_KEY","value":"sk_live_..."},{"key":"FEATURE_FLAG_X","value":"true"}]}'

# 2. Redeploy (new source or the same source again) so the app actually sees them
curl -X POST "https://ship.hostnsoft.com/apps" \
  -H "Authorization: Bearer $DEPLOY_TOKEN" -H "X-App-Name: my-app" -F "source=@/tmp/my-app.tar.gz"
```

Keys must match `^[A-Za-z_][A-Za-z0-9_]*$`. Other operations:

```bash
# List current env vars
curl "https://api.hostnsoft.com/companies/$COMPANY_ID/projects/$PROJECT_ID/env-vars" -H "proxy_auth_token: $TOKEN"

# Remove one
curl -X DELETE "https://api.hostnsoft.com/companies/$COMPANY_ID/projects/$PROJECT_ID/env-vars/STRIPE_KEY" -H "proxy_auth_token: $TOKEN"
```

## [Memory allocation](#memory-allocation)

Default is 256MB (512MB if an embedded DB like PGlite is auto-detected).
Override it, then apply it the same way as an env var change:

```bash
curl -X PATCH "https://api.hostnsoft.com/companies/$COMPANY_ID/projects/$PROJECT_ID/memory" \
  -H "proxy_auth_token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"memoryMb": 1024}'
```

This only **persists** the new value — it takes effect on the next deploy,
rollback, or custom-domain change, not immediately. If you don't have a new
build to ship, the fastest way to apply a memory change alone is rolling
back to the **current** version (see below) — that re-pushes the job spec
with no rebuild.

## [Rollback](#rollback)

One click, no rebuild — reruns a past successful build's image under the
current config (current env vars and custom domains, not whatever they were
at the time of that old deploy):

```bash
# 1. Find the deployment id you want
curl "https://api.hostnsoft.com/companies/$COMPANY_ID/projects/$PROJECT_ID/deployments" -H "proxy_auth_token: $TOKEN"

# 2. Roll back to it
curl -X POST "https://api.hostnsoft.com/companies/$COMPANY_ID/projects/$PROJECT_ID/deployments/$DEPLOYMENT_ID/rollback" \
  -H "proxy_auth_token: $TOKEN"
```

Only deployments with `status: "success"` are valid targets. Rolling back
creates a **new** deployment history entry pointing at the old image — it
doesn't rewrite history. See
[`troubleshoot.md`](troubleshoot.md#rollback-target-image-unavailable) if the
target image was cleaned from the host.

## [Custom domain mapping](#custom-domains)

Point your own domain at a deployed app, instead of (or alongside) its
default `<app-name>.app.hostnsoft.com` URL.

**1. Register intent** — get back the exact DNS record to create:

```bash
curl -X POST "https://api.hostnsoft.com/companies/$COMPANY_ID/projects/$PROJECT_ID/domains" \
  -H "proxy_auth_token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"domain": "app.yourdomain.com"}'
```

```json
{
  "domain": "app.yourdomain.com",
  "status": "pending_dns",
  "instructions": { "type": "CNAME", "name": "app.yourdomain.com", "value": "edge.hostnsoft.com" }
}
```

A **subdomain** (like `app.yourdomain.com`) gets a `CNAME` to a dedicated
platform hostname. An **apex/root domain** (`yourdomain.com`, no subdomain)
can't use `CNAME` under standard DNS rules — you'll get an `A` record to the
platform's origin IP instead, which means it bypasses any CDN/proxy you'd
normally put in front of it (see
[`troubleshoot.md`](troubleshoot.md#apex-root-domains-lose-your-cdnproxy-in-front-of-them)).

**2. Create that exact DNS record** with your DNS provider. If using
Cloudflare, make sure it's set to **DNS only** (grey cloud), not **Proxied**
(orange cloud) — a proxied record will never verify, see
[`troubleshoot.md`](troubleshoot.md#verify-stuck-on-not-resolving-yet-despite-a-correct-looking-record).

**3. Verify** — safe to retry repeatedly until DNS propagates:

```bash
curl -X POST "https://api.hostnsoft.com/companies/$COMPANY_ID/projects/$PROJECT_ID/domains/app.yourdomain.com/verify" \
  -H "proxy_auth_token: $TOKEN"
```

Routing only activates once this confirms DNS actually resolves correctly —
nothing is activated at step 1. Once active, `status` becomes `"active"` in:

```bash
curl "https://api.hostnsoft.com/companies/$COMPANY_ID/projects/$PROJECT_ID/domains" -H "proxy_auth_token: $TOKEN"
```

**Removing a domain** tears down just that domain's routing/certificate —
your app's default `*.app.hostnsoft.com` URL is never affected:

```bash
curl -X DELETE "https://api.hostnsoft.com/companies/$COMPANY_ID/projects/$PROJECT_ID/domains/app.yourdomain.com" \
  -H "proxy_auth_token: $TOKEN"
```

Custom domains require port 80 reachable for certificate issuance — see
[`troubleshoot.md`](troubleshoot.md#custom-domain-activation-requires-port-80-reachable)
if verification never completes despite correct DNS.

## [Feature requests & feedback](#feature-requests)

Three ways to send a feature request or piece of feedback to the platform,
depending on who's sending it. `type` is always `"feature"` or `"feedback"`;
`message` is required (max 5000 characters). All three return
`{"id": "..."}` on success (`201`).

### [From the dashboard (logged in)](#feature-requests-dashboard)

```bash
curl -X POST "https://api.hostnsoft.com/companies/$COMPANY_ID/feature-requests" \
  -H "proxy_auth_token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"type": "feature", "message": "Would love a staging environment per project"}'
```

Your email is taken from your logged-in identity — not sent in the request.

### [From an AI agent, while deploying](#feature-requests-agent)

For an agent (Claude Code, ChatGPT, whatever) to report feedback about the
app it's actively deploying, without needing dashboard credentials at all —
same auth as `.../status`/`.../logs` (a token is required once the app is
claimed, optional while it's still an anonymous orphan):

```bash
curl -X POST "https://ship.hostnsoft.com/apps/my-app/feature-requests" \
  -H "Authorization: Bearer $DEPLOY_TOKEN" \
  -H "X-Agent-Name: Claude Code" \
  -H "Content-Type: application/json" \
  -d '{"type": "feedback", "message": "Deploy docs did not mention DATA_DIR clearly enough"}'
```

`X-Agent-Name` is required — free text, so any current or future agent can
identify itself without needing a platform change to be recognized.

### [Anonymous, no account at all](#feature-requests-public)

```bash
curl -X POST "https://api.hostnsoft.com/public/feature-requests" \
  -H "Content-Type: application/json" \
  -d '{"type": "feedback", "message": "...", "email": "you@example.com"}'
```

Rate-limited (per-email, per-IP, and globally — see
[`troubleshoot.md`](troubleshoot.md#public-unauthenticated-endpoints-are-rate-limited))
since it requires no authentication at all.

## [Monitoring your app](#monitoring)

```bash
# Current health + latest deployment + memory allocation
curl "https://api.hostnsoft.com/companies/$COMPANY_ID/projects/$PROJECT_ID" -H "proxy_auth_token: $TOKEN"

# Full deployment history
curl "https://api.hostnsoft.com/companies/$COMPANY_ID/projects/$PROJECT_ID/deployments" -H "proxy_auth_token: $TOKEN"

# Recent logs (a snapshot, not a live stream — poll if you need to watch it happen)
curl "https://ship.hostnsoft.com/apps/my-app/logs" -H "Authorization: Bearer $DEPLOY_TOKEN"

# Traffic + resource usage over time
curl "https://api.hostnsoft.com/companies/$COMPANY_ID/projects/$PROJECT_ID/analytics?range=7d" -H "proxy_auth_token: $TOKEN"
```

`range` accepts `24h`, `7d`, `30d`, `90d`, or `all`.

## [Deleting a project](#deleting-a-project)

```bash
curl -X DELETE "https://api.hostnsoft.com/companies/$COMPANY_ID/projects/$PROJECT_ID" -H "proxy_auth_token: $TOKEN"
```

Tears down the running app (Nomad job, Traefik routing, Docker image) as
well as the dashboard record — this is not reversible.

## [Errors and known limitations](#errors)

See [`troubleshoot.md`](troubleshoot.md) for the full error-code reference
and the platform's actual constraints (persistence, memory/CPU/disk, rate
limits) — worth reading once before you build something that assumes
guarantees the platform doesn't make.
