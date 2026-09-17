# Embarko Troubleshooting

Real failures the platform has thrown — not hypotheticals. Each entry:
`match` (exact substring to look for in a response body or logs) → `cause`
→ `fix`.

Covers the whole platform surface: deploying (`POST /apps`) and everything
you can do to a project afterward (env vars, memory, rollback, custom
domains, monitoring). See [`docs.md`](docs.md) for the full API reference
this troubleshooting guide assumes, and
[`limitations-and-recommendations.md`](limitations-and-recommendations.md)
for the platform's real constraints and how to design around them —
*before* you hit them, not after.

## Build-time rejections (before any build runs)

### 422 unsupported_storage_pattern
- match: `"window.storage"` in the 422 response detail
- cause: app calls `window.storage`, a Claude Artifacts sandbox API that doesn't exist outside it
- fix: replace with SQLite (`better-sqlite3`), writing under `DATA_DIR`
  (relational) — write under `DATA_DIR` either way, see
  [Only `DATA_DIR` survives a redeploy](limitations-and-recommendations.md#only-data_dir-survives-a-redeploy)
  — then redeploy

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
- cause: a transient internal error while checking name availability
- fix: safe to retry as-is; no need to change anything about the request

## Runtime crashes (build succeeded, app failed after)

### OOM killed
- match: `"OOM Killed"`, `Exit Code: 137`
- cause: app exceeds its allocated memory (256MB). Common causes: an
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

### WebAssembly apps fail with CompileError and a blank page (fixed platform-wide)
- match: browser console shows `CompileError` from `WebAssembly.compile`/`instantiate`, or a CSP violation
  naming `script-src`; page itself loads (200) but renders blank
- cause: **historical** — static-build apps (Godot/Unity/Emscripten/Rust-wasm exports have no `package.json`,
  so they're served by Railpack's own built-in static-file server) inherited that server's default
  Content-Security-Policy, which didn't include `'wasm-unsafe-eval'` in `script-src`. This platform sets no
  CSP of its own at the edge before this fix, so whatever the app's own container happened to set is what a
  browser saw.
- fix: **no longer needed for apps deployed/redeployed after this platform update** — the platform now
  applies a corrected default CSP (same as before, plus `'wasm-unsafe-eval'`) at the edge for every app,
  which takes precedence over anything the app's own container sets. Confirm with
  `curl -sI https://<app>.app.embarko.ai/ | grep -i content-security-policy`; if it's still missing
  `wasm-unsafe-eval`, the app hasn't been redeployed since this fix — trigger any redeploy (even a no-op
  rollback to the current version) to pick it up.

## Access & ownership

### 404 on status/logs endpoint
- match: `{"error":"Not found"}` from `GET .../status` or `.../logs`
- cause: a claimed app's status/logs require its owning company's token; an orphan app allows no token at
  all. A wrong or missing token on a claimed app always returns 404, never confirming the app exists.
- fix: send `Authorization: Bearer <deploy token>` for a claimed app; omit the header entirely if it's
  still meant to be an orphan

## Customer queries (feature requests / feedback / other)

**Renamed 2026-09-09**: this was `.../feature-requests` on all three paths (dashboard, public, agent);
now `.../customer-query`. Same data, same behavior, `type` now also accepts `"other"` alongside
`"feature"`/`"feedback"`.

### 400 "X-Agent-Name header is required"
- match: `"X-Agent-Name header is required"`
- cause: submitting via `POST <ship host>/apps/:appName/customer-query` (the agent-facing path)
  without the `X-Agent-Name` header
- fix: add `X-Agent-Name: <your agent's name>` — free text, any value identifying the calling agent works

### 502 from the agent customer-query endpoint
- match: HTTP 502 from `POST .../apps/:appName/customer-query`
- cause: an internal error forwarding or storing the request
- fix: transient — safe to retry. If it persists, the message/type may be invalid (`type` must be exactly
  `"feature"`, `"feedback"`, or `"other"`; `message` 1–5000 characters)

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
  project that's automatically torn down (the running app, its routing, and its image all
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

## Async operations (not actual failures)

### 202 Accepted misread as "live" (deploy)
- match: `{"accepted":true}`, HTTP 202, from `POST /apps`
- cause: not a failure — the deploy API responds immediately and the build continues in the background
- fix: poll `statusUrl` from the response until `deploy.status` is `"success"` or `"failed"`; never treat
  `202` itself as done

### 202 Accepted misread as "done" (rollback)
- match: `{"accepted":true,"deploymentId":"...","statusUrl":"..."}`, HTTP 202, from
  `POST .../deployments/:deploymentId/rollback`
- cause: not a failure — the target image was confirmed to exist (that's the one check worth failing
  fast on) and rollback is applying in the background; the app isn't necessarily running the rolled-back
  version yet at the moment this response arrives
- fix: poll the response's `statusUrl` (`GET .../deployments/:deploymentId`) until its `status` is no
  longer `"in_progress"`

### 524 timeout (historical, should be rare now)
- match: `524`, `"A timeout occurred"`
- cause: previously caused by the deploy endpoint blocking on the full build before responding; fixed by
  the async 202 flow above. If seen now, the slow part is likely the upload itself, not the build.
- fix: check upload size/network first; report if it persists on a normal-sized upload

## Rollback

### Rollback target image unavailable
- match: HTTP 422, `"code":"rollback_image_unavailable"`, message starts with `"Cannot roll back: the
  image is no longer available"`
- cause: images are built locally on the platform's host and never pushed to a registry, and only the
  most recent handful are kept (see
  [`limitations-and-recommendations.md`](limitations-and-recommendations.md#only-the-last-n-build-images-are-kept-per-app) —
  the response's own `retainCount` field always says exactly how many). The target version's image has
  already been pruned.
- fix: roll back to one of the last `retainCount` deployments instead (see `GET .../deployments`), or
  redeploy the old source fresh if you still have it — either way, the exact number is in the error
  response itself, not something you need to look up separately

### Rollback returns 422 for a different reason
- match: HTTP 422 from `POST .../deployments/:deploymentId/rollback`, `error` does NOT start with
  `"Cannot roll back: the image is no longer available"`
- cause: the target deployment either didn't succeed (`status !== "success"`) or has no recorded image tag
- fix: pick a different deployment from `GET .../deployments` — only successful ones with an image are
  valid rollback targets

## Configuration changes that don't apply until you redeploy

### Changing memory doesn't take effect immediately
- no `match` — a behavior to know about, not an error
- cause: `PATCH .../memory` only **persists** the new value in the dashboard's database. It does not push
  a config change to the already-running app.
- fix: the new limit takes effect the next time the app's configuration is regenerated — a fresh deploy
  (`POST /apps`), a rollback, or a custom-domain change all do this. If you just need the new memory limit
  applied with no code change, roll back to the **current** version — that re-applies the current
  configuration with the new memory floor and no rebuild

### Env var changes need a redeploy to reach the running app
- no `match` — a behavior to know about, not an error
- cause: env vars are baked into the app's configuration at deploy time, not pushed live to an already-running
  container
- fix: after `PUT .../env-vars`, trigger a new deploy (`POST /apps`, even with unchanged source) for the app
  to actually see the new values — see `docs.md`'s
  [Environment variables](docs.md#environment-variables) section for the exact steps

## Platform-level constraints (apply to every app, always true — not failures)

These aren't things that go wrong — they're the actual shape of the platform, worth designing around
rather than assuming stronger guarantees than it makes. Moved to their own doc, paired with concrete
recommendations for building around each one: see
[`limitations-and-recommendations.md`](limitations-and-recommendations.md).
