# Embarko Troubleshooting

Real failures the platform has thrown, and known constraints of the platform
itself — not hypotheticals. Each failure entry: `match` (exact substring to
look for in a response body or logs) → `cause` → `fix`. Constraints have no
`match` since they're not errors — they're things to design your app around
*before* you hit them.

This supersedes `deploy-troubleshooting.md` (kept in place, but consider it
frozen) and covers the whole platform surface — `hostnsoft-deploy`'s
`POST /apps` plus every `hostnsoft-api` endpoint (env vars, memory, rollback,
custom domains). If you're only calling `POST /apps` directly (no dashboard),
see also `hostnsoft-skill/scripts/troubleshoot.md`, which covers the same
deploy-call errors in framework-agnostic language for an agent.

## Build-time rejections (before any build runs)

### 422 unsupported_storage_pattern
- match: `"window.storage"` in the 422 response detail
- cause: app calls `window.storage`, a Claude Artifacts sandbox API that doesn't exist outside it
- fix: replace with SQLite (`better-sqlite3`, simple key/value) or `@electric-sql/pglite`
  (relational) — write under `DATA_DIR` either way, see
  [Your data will be wiped on every redeploy](#your-data-will-be-wiped-on-every-redeploy-unless-its-under-data_dir)
  below — then redeploy

### 401 unauthorized
- match: `{"error":"Unauthorized","code":"unauthorized"}`
- cause: `Authorization` header present but token invalid/revoked. Omitting the header entirely = anonymous
  deploy (fine). Sending a broken one is never silently treated as anonymous.
- fix: verify the token is live and not rotated/revoked, or omit the header entirely for an anonymous deploy

### 409 app_name_taken
- match: `"already in use by a different company"`
- cause: `X-App-Name` is also the live subdomain — must be unique across the whole platform, not just your account
- fix: pick a different `X-App-Name`, or claim the existing orphan with a real token before its 24h expiry

### 502 app_name_check_failed
- match: `"code":"app_name_check_failed"`
- cause: the deploy service couldn't reach `hostnsoft-api` to check name availability — transient
- fix: safe to retry as-is; no need to change anything about the request

## Runtime crashes (build succeeded, app failed after)

### OOM killed
- match: `"OOM Killed"`, `Exit Code: 137`
- cause: app exceeds its allocated memory (256MB default, 512MB if PGlite is auto-detected). Common causes: an
  embedded DB the platform didn't auto-detect, or a dev-mode server (e.g. a "dev" CLI) shipped as the production
  start command
- fix: `PATCH .../memory {"memoryMb": 1024}`, **then redeploy or roll back** — this endpoint only persists the
  new value, it does not itself push it to the running app (see
  [Changing memory doesn't take effect immediately](#changing-memory-doesnt-take-effect-immediately) below)

### Crash loop exhausted
- match: `"Not Restarting"`, `"Exceeded allowed attempts"`
- cause: symptom, not the root cause — the real reason is logged just above this line (usually an OOM kill
  or an uncaught startup exception)
- fix: `GET .../logs`, find the actual cause above this line, fix it, redeploy (resets the attempt counter)

### Pull access denied for a freshly built image
- match: `"pull access denied"`
- cause: platform-side bug — an image got referenced without a proper local version tag. Not caused by
  normal use of the deploy API.
- fix: not user-fixable; report the app name and timestamp

## Access & ownership

### 404 on status/logs endpoint
- match: `{"error":"Not found"}` from `GET .../status` or `.../logs`
- cause: a claimed app's status/logs require its owning company's token; an orphan app allows no token at
  all. A wrong or missing token on a claimed app always returns 404, never confirming the app exists.
- fix: send `Authorization: Bearer <deploy token>` for a claimed app; omit the header entirely if it's
  still meant to be an orphan

## Feature requests & feedback

### 400 "X-Agent-Name header is required"
- match: `"X-Agent-Name header is required"`
- cause: submitting feedback via `POST <ship host>/apps/:appName/feature-requests` (the agent-facing path)
  without the `X-Agent-Name` header
- fix: add `X-Agent-Name: <your agent's name>` — free text, any value identifying the calling agent works

### 502 from the agent feedback endpoint
- match: HTTP 502 from `POST .../apps/:appName/feature-requests`
- cause: hostnsoft-deploy couldn't reach hostnsoft-api to forward the request, or hostnsoft-api rejected it
- fix: transient — safe to retry. If it persists, the message/type may be invalid (`type` must be exactly
  `"feature"` or `"feedback"`, `message` 1–5000 characters)

## Custom domains

### Custom domain DNS not propagated
- match: `"DNS does not yet point at the platform"`
- cause: the custom domain's DNS record isn't set correctly yet, or hasn't propagated
- fix: confirm the CNAME/A record matches the `POST .../domains` response exactly, then retry
  `.../verify` after propagation — safe to retry repeatedly

### Verify stuck on "Not resolving yet" despite a correct-looking record
- match: dashboard shows `"Not resolving yet"` even though the CNAME/A record in your DNS
  provider matches what was given exactly
- cause: the DNS provider is proxying the record (e.g. Cloudflare's orange-cloud "Proxied"
  mode) instead of serving it as plain DNS. A proxied record doesn't actually resolve to the
  value shown in your dashboard — it resolves to the provider's own proxy IPs, which is why
  verification can't confirm it
- fix: switch the record to DNS-only / unproxied (in Cloudflare: click the orange cloud icon
  next to the record so it turns grey), then retry `.../verify` — should pass within a minute
  or two, since no real propagation delay is involved, just the proxy-mode change

### Apex (root) domains lose your CDN/proxy in front of them
- no `match` — this is a design constraint, not an error
- cause: a subdomain custom domain gets a `CNAME` to a dedicated, permanently-unproxied
  platform hostname; an apex domain (`yourdomain.com` with no subdomain) can't use `CNAME` at
  all under standard DNS rules, so it gets an `A` record pointing directly at the platform's
  origin server IP instead. That means an apex custom domain talks to the origin directly —
  whatever CDN/DDoS protection you'd normally get from proxying (Cloudflare, etc.) doesn't
  apply to it.
- fix: prefer a subdomain (`app.yourdomain.com`) over an apex domain if you want to keep your
  own CDN/proxy in front of traffic to this app

### Custom domain activation requires port 80 reachable
- no `match` — a design constraint that surfaces as verification silently never succeeding
- cause: custom domains use an HTTP-01 challenge (unlike the platform's own domains, which use
  DNS-01) — it needs port 80 reachable and unredirected for `/.well-known/acme-challenge/*`
  specifically. If your own infrastructure in front of this domain (a firewall, a different
  proxy) blocks or redirects port 80 before it reaches the platform, verification/cert
  issuance will never complete.
- fix: confirm port 80 reaches the platform unmodified for this hostname before troubleshooting
  anything else

## Anonymous ("orphan") deploys

### Your app disappears ~24 hours after an anonymous deploy
- no `match` — this is by design, not a bug
- cause: a deploy with no `Authorization` header at all creates an unclaimed ("orphan")
  project that's automatically torn down (Nomad job, Traefik routing, and Docker image all
  removed) 24 hours after creation, unless claimed first
- fix: redeploy the same `X-App-Name` **with** a valid token before it expires — this claims
  the project under your company, cancels the expiry, and behaves exactly like any other
  project from then on. There is only one warning: the deploy response's `orphan.message`
  and an in-app banner (see below) — no reminder email as it approaches expiry.

### The in-app "will be deleted" banner doesn't show up
- no `match` — a known scope limitation, not a bug
- cause: the banner is injected by rewriting `text/html` HTTP responses only (a sidecar
  proxy in front of your app, working regardless of your app's language/framework). A
  JSON-only API with no HTML page has nothing for it to inject into — the deploy response's
  `orphan.message` is still the authoritative notice, it just never reaches a browser
- fix: nothing to fix — this is expected for non-HTML apps; rely on the deploy response
  message instead of the in-app banner for those

## Async deploy flow (not actual failures)

### 202 Accepted misread as "live"
- match: `{"accepted":true}`, HTTP 202
- cause: not a failure — the deploy API responds immediately and the build continues in the background
- fix: poll `statusUrl` from the response until `deploy.status` is `"success"` or `"failed"`; never treat
  `202` itself as done

### 524 timeout (historical, should be rare now)
- match: `524`, `"A timeout occurred"`
- cause: previously caused by the deploy endpoint blocking on the full build before responding; fixed by
  the async 202 flow above. If seen now, the slow part is likely the upload itself, not the build.
- fix: check upload size/network first; report if it persists on a normal-sized upload

## Rollback

### Rollback target image unavailable
- match: `"is no longer available on this host"`
- cause: images are built locally on the platform's host and never pushed to a registry. The target
  version's build image was cleaned from the host (very old version, or the host was rebuilt since)
- fix: roll back to a more recent version, or redeploy the old source fresh if you still have it

### Rollback returns 422
- match: HTTP 422 from `POST .../deployments/:deploymentId/rollback`
- cause: the target deployment either didn't succeed (`status !== "success"`) or has no recorded image tag
- fix: pick a different deployment from `GET .../deployments` — only successful ones with an image are
  valid rollback targets

## Configuration changes that don't apply until you redeploy

### Changing memory doesn't take effect immediately
- no `match` — a behavior to know about, not an error
- cause: `PATCH .../memory` only **persists** the new value in the dashboard's database. It does not push
  a config change to the already-running app.
- fix: the new limit takes effect the next time the app's job spec is regenerated — a fresh deploy
  (`POST /apps`), a rollback, or a custom-domain change all do this. If you just need the new memory limit
  applied with no code change, roll back to the **current** version — that re-pushes the spec with the new
  memory floor and no rebuild

### Env var changes need a redeploy to reach the running app
- no `match` — a behavior to know about, not an error
- cause: env vars are baked into the app's Nomad job spec at deploy time, not pushed live to an already-running
  container
- fix: after `PUT .../env-vars`, trigger a new deploy (`POST /apps`, even with unchanged source) for the app
  to actually see the new values — see `docs.md`'s
  [Environment variables](docs.md#environment-variables) section for the exact steps

## Platform-level constraints (apply to every app, always true — not failures)

These aren't things that go wrong; they're the actual shape of the platform. Design around them rather
than assuming stronger guarantees than what's listed here.

### Your data will be wiped on every redeploy unless it's under `DATA_DIR`
- Every redeploy builds a fresh image and schedules a fresh container. The **only** directory that survives
  across redeploys is whatever `DATA_DIR` points at (an env var provided to your app) — everything else in
  the container's filesystem is reset to exactly what your image contains, every time.
- If your code assumes a folder exists that isn't part of your uploaded source **and** isn't under
  `DATA_DIR` (e.g. `fs.writeFileSync('./analytics/results.json', ...)` with no prior `mkdir`), it can also
  crash at runtime with `ENOENT` the first time it tries to write — not just lose data on the next deploy,
  fail immediately.
- fix: read/write anything that needs to survive a redeploy (a SQLite file, analytics counters, uploaded
  files, A/B test results, anything) under `path.join(process.env.DATA_DIR, ...)`, creating subdirectories
  with `{ recursive: true }` on startup rather than assuming they exist.

### CPU limits are a relative share, not a hard cap
- The platform reserves memory per app (hard-enforced, confirmed via a real OOM incident where the kernel
  killed one container without affecting others) but CPU is a relative weight, not a ceiling — a CPU-heavy
  neighbor app can degrade your app's performance under contention. Don't rely on CPU isolation for a
  workload that's sensitive to that.

### Disk usage isn't quota-enforced, including under `DATA_DIR`
- Nothing currently stops an app from writing far more to disk than its own reasonable share, whether
  that's under `DATA_DIR` or not — the platform doesn't cap this per app today. Keep an eye on unbounded
  logs/caches/uploads; a runaway app can affect the shared host, not just itself.

### Network isolation between different apps' containers is unverified
- Whether one app's container can reach another app's container directly over the Docker network,
  bypassing Traefik entirely, has not been tested either way. Don't rely on container-to-container
  isolation as a security boundary for anything sensitive until this is explicitly confirmed.

### Logs are a recent snapshot, not a live stream
- `GET .../logs` returns the tail of the most recent allocation's logs at the moment you call it — it does
  not stream. Poll it if you need to watch logs as they happen.

### Public, unauthenticated endpoints are rate-limited
- `POST /public/deploy-tokens/request` and `POST /public/feature-requests` are capped per-email, per-IP,
  and globally (defaults: 5/hour per email, 10/hour per IP for token requests; 10/email, 20/IP, 500/global
  per hour for feature requests). Both always return the same generic success response regardless of
  whether the rate limit was hit or the email exists — retries beyond the limit are silently no-ops, not
  errors, so don't loop on a missing email without waiting.
