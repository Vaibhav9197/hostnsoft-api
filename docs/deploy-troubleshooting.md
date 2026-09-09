# Embarko Deploy Troubleshooting

Real failures the deploy API has thrown, not hypotheticals. Each entry: `match` (exact substring to
look for in a response body or `GET .../logs` output) → `cause` → `fix`.

## Build-time rejections (before any build runs)

### 422 unsupported_storage_pattern
- match: `"window.storage"` in the 422 response detail
- cause: app calls `window.storage`, a Claude Artifacts sandbox API that doesn't exist outside it
- fix: replace with SQLite (simple key/value) or `@electric-sql/pglite` (relational), redeploy

### 401 unauthorized
- match: `{"error":"Unauthorized","code":"unauthorized"}`
- cause: `Authorization` header present but token invalid/revoked. Omitting the header entirely = anonymous
  deploy (fine). Sending a broken one is never silently treated as anonymous.
- fix: verify the token is live and not rotated/revoked, or omit the header entirely for an anonymous deploy

### 409 app_name_taken
- match: `"already in use by a different company"`
- cause: `X-App-Name` is also the live subdomain — must be unique across the whole platform, not just your account
- fix: pick a different `X-App-Name`, or claim the existing orphan with a real token before its 24h expiry

## Runtime crashes (build succeeded, app failed after)

### OOM killed
- match: `"OOM Killed"`, `Exit Code: 137`
- cause: app exceeds its allocated memory (256MB default). Common causes: an embedded DB the platform
  didn't auto-detect, or a dev-mode server (e.g. a "dev" CLI) shipped as the production start command
- fix: `PATCH .../memory {"memoryMb": 1024}`, then redeploy — or roll back to the current version to apply
  the new ceiling immediately with no rebuild

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
- cause: the target version's build image was cleaned from the host (very old version, or host rebuilt since)
- fix: roll back to a more recent version, or redeploy the old source fresh if you still have it
