# Schedules

Timed calls into an app: "every weekday at 9:00 Kolkata time, call
`GET /tasks/daily-digest`". This is how an app built by an AI agent runs
work without a person or visitor triggering it, on a platform that puts
idle apps to sleep. Added 2026-10-17.

## Design

Embarko does not run app code on a timer. At each due time, this service
sends an HTTP `GET <path>` to the app's own address. That request takes the
same path a visitor's does, so:

- a sleeping app is woken by it (the deploy service's wake-up path holds
  the request up to 90s while the app starts), and scale-to-zero needs no
  change;
- the call counts as real traffic, so the app then stays awake for the
  normal idle threshold. A schedule more frequent than the idle threshold
  (6h) keeps the app awake permanently.

Rejected alternatives, and why:

- **Nomad periodic batch jobs** (a container per run): a second kind of
  job that the sleep logic, logs, status and rename would all need to learn
  about, plus memory spikes when many schedules share `0 * * * *` on one
  server. Revisit only for runs longer than one HTTP request allows.
- **Sending people to an external scheduler** (viaSocket, cron-job.org):
  still works and the guide still mentions it for schedules that need
  integrations, but making it the only way needs a second account for
  "every morning at 9".

## Declared on deploy (the normal way)

The app lists its schedules in an optional `embarko.json` in its top
folder, so setting one up is "write the route, list it, deploy, check the
test run". Added 2026-10-17.

```json
{ "schedules": [{ "cron": "0 9 * * 1-5", "path": "/tasks/daily-digest", "timezone": "Asia/Kolkata" }] }
```

- **The file:** read by the deploy service from the uploaded archive, before
  the claim (its `embarko-config.js`; file rules, refusals and warnings in
  hostnsoft-deploy's `docs/embarko-json.md`). Works for every upload path,
  including the connector's JSON `files[]`. An `X-Schedules` header was built
  first and dropped before release.
- **The list is the full set.** Matched by path: a listed path is created or
  updated (keeping its id, run history, alert webhook and failure state),
  an unlisted one is deleted, `[]` deletes all. **No file, or no `schedules`
  key, leaves schedules as they are**, so ordinary redeploys never touch
  them; the claim returns `scheduleCount` so the deploy reply can warn
  `schedules_unchanged` when the app has some. Declaring a paused schedule
  turns it back on: the file is the source of truth.
- **Claim, before the build** (`POST /internal/projects/claim`, field
  `schedules`): the list is validated (`validateDeclaredSchedules`); a bad
  one refuses the deploy with `400` and a code naming it ("Schedule 2:
  …"). For a kept app with at least one schedule, `CRON_SECRET` is created
  if missing (`ensureCronSecret`, 32 random bytes, never replaced), before
  the env read, so the new container starts with it. The claim reply gains
  `schedules: {declared, accepted, reason?}`, and always `scheduleCount`.
- **Success** (`POST /internal/deployments/record`, `status: "success"`,
  field `schedules`): `syncDeclaredSchedules` applies the list. Skipped for a
  static site and a temporary app. Best-effort: a failure is logged, the
  deploy stays successful. A failed build never changes the schedules.
- **Temporary (anonymous) apps** deploy normally but their schedules are not
  applied: no owner to alert, no token to manage them. The deploy reply
  says so (`schedules.applied: false` + `reason`).
- **Deploy reply** (202): `schedules: {declared, appliesWhen: "live"}`, a
  sentence in `next`, and `links.runSchedules`. The skill script polls until
  live, calls it, polls each run and prints `ok` or the error, exiting 1 if
  any failed.

The agent API below stays for reading runs, pausing one schedule, the alert
webhook, and agents that don't redeploy. A schedule created there also gets
`CRON_SECRET` created, which reaches the running app on its next deploy or
env-vars apply.

## Where it runs

`src/services/scheduleRunner.ts`, started from `server.ts` beside the
other loops. Every `SCHEDULE_TICK_MS` (30s) it takes enabled schedules
whose `nextRunAt` has passed, advances each `nextRunAt` first with a
compare-and-set on the old value (so two processes can't fire one
occurrence), then calls the app.

- **Missed occurrences** (this service was down): an overdue schedule runs
  once, then resumes from the next occurrence after now. No replay.
- **Overlap**: a schedule whose previous run is still in flight records a
  `skipped` run instead. In-flight tracking is in-process, like
  `renameStatus.ts`; run a single instance.
- **Concurrency**: at most `SCHEDULE_MAX_CONCURRENT_RUNS` calls in flight
  across all apps; the rest wait for the next tick.
- **Restart**: runs left `running` by a previous process are closed as
  `failed` ("Interrupted") on startup.

### The call

- `GET https://<slug>.<APP_PUBLIC_DOMAIN><path>`, connected straight to
  `SCHEDULE_TARGET_IP` (default `ORIGIN_SERVER_IP`) on
  `SCHEDULE_TARGET_PORT` (443), with the app's hostname kept for TLS and
  the `Host` header. This bypasses the CDN in front of the app domain,
  which cuts responses off at ~100s. **Verify on the test environment that
  the box can reach its own public IP; if not, set
  `SCHEDULE_TARGET_IP=127.0.0.1`.**
- Headers: `User-Agent: Embarko-Scheduler/1.0 (+https://embarko.ai/docs/schedules)`,
  `X-Embarko-Schedule-Id`, `X-Embarko-Run-Id`, and
  `Authorization: Bearer <CRON_SECRET>` when the app has an env var named
  `CRON_SECRET` (same convention as Vercel cron). The app checks it to
  refuse anyone else calling the same path.
- Outcome: 2xx = `ok`. Anything else is `failed`. Redirects are not
  followed (failed, with the location in the error). No complete response
  within `SCHEDULE_RUN_TIMEOUT_MS` (5 min, wake-up included) = `failed`.
- The first `SCHEDULE_RESPONSE_EXCERPT_BYTES` (2KB) of the body is kept on
  the run, so an app can return a one-line summary of what it did.
- Static sites can't have schedules (`409 not_supported_for_static`), and a
  schedule on an app that later became static is not run.

The deploy service's bot filter must not match the scheduler's User-Agent,
or a sleeping app would not wake. It doesn't (`bot\b` needs a word
boundary after "bot").

## Alerts

One alert when a schedule starts failing, one when it recovers, never one
per failed run (`Schedule.failing`, `consecutiveFailures`, `failingSince`).
"Starts failing" means `SCHEDULE_ALERT_AFTER_FAILURES` (default 3) runs
failed in a row, or the streak is `SCHEDULE_ALERT_AFTER_HOURS` (default 6)
old with no success, whichever comes first. A single failed run is usually
a blip (a dropped connection while the proxy restarted) that the next run
gets past, so a shorter, younger streak only counts up and resets on the
next success, with no alert and no "Needs attention" on the dashboard. The
age rule is for slow schedules: a daily job would otherwise wait three days.
The runner checks streak ages every tick, so it fires even when no further
run is due; paused schedules are skipped. The recovered alert goes only
after a failing alert did. Both destinations are best-effort, logged on failure,
never retried:

- **Email** to the project's creator (`Project.createdBy`, else the
  schedule's creator), through the viaSocket email flow
  (`Webhook.SCHEDULE_ALERT_EMAIL`, same payload shape as the token mail).
  Short, for an owner who didn't write the app: which job stopped working
  and how many times it failed, no error text, cron or status codes, and two
  buttons. "Fix with your AI" opens `embarko.ai/fix#<base64url JSON {app,
  job, prompt}>` (`fixLink`), a page that copies the prompt on arrival (an
  email can't touch the clipboard; Safari and Firefox need one tap). The
  prompt carries the real error and the app's reply, rides in the URL
  fragment so no server log keeps it, and mirrors the dashboard's
  `consoleFixSchedulePrompt` (hostnsoft `app/lib/deployPrompt.ts`) — change
  both. "Open in Embarko" goes to the app's dashboard page.
- **Webhook** (optional, per schedule, `alertWebhookUrl`): `POST` JSON

```json
{
  "event": "schedule.failed",
  "app": { "name": "my-app", "url": "https://my-app.embarko.app" },
  "schedule": { "id": "…", "name": "daily digest", "cron": "0 9 * * 1-5", "timezone": "Asia/Kolkata", "path": "/tasks/daily-digest" },
  "run": { "id": "…", "trigger": "schedule", "outcome": "failed", "terminal": true, "httpStatus": 500, "error": "HTTP 500", "responseExcerpt": "…", "startedAt": "…", "finishedAt": "…", "durationMs": 812 },
  "consecutiveFailures": 3,
  "sentAt": "…"
}
```

`event` is `schedule.failed` or `schedule.recovered`. The URL must be
public `https://`: checked on save and again before each send (DNS may
change), private and link-local addresses refused, redirects not followed.
It is treated as a secret, like env var values: no endpoint returns it,
only `alertWebhook: {set, host}`.

## Agent API

Deploy-token authenticated, under `/api/apps/:appName` (see
`agentApps.routes.ts`). Every endpoint returns the same schedule shape.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/schedules` | `{schedules: [Schedule], limit}` |
| POST | `/schedules` | `{cron, path, timezone?, name?, enabled?, alertWebhookUrl?}` → `201 Schedule` |
| GET | `/schedules/:id` | `Schedule` |
| PATCH | `/schedules/:id` | Any of the create fields; `name` and `alertWebhookUrl` accept `null` to clear |
| DELETE | `/schedules/:id` | `204` |
| POST | `/schedules/run` | Run every schedule once now. `202 {runs: [Run + scheduleId, path, statusUrl]}`; a schedule already running appears as `{scheduleId, path, started: false, code: "run_in_progress"}`; `404 no_schedules` |
| POST | `/schedules/:id/run` | Run once now, also when paused. `202 Run + statusUrl`; `409 run_in_progress` |
| GET | `/schedules/:id/runs?limit=20&page=1&outcome=&trigger=` | `{runs: [Run], page, pageSize, total, totalPages, kept}`, newest first. `outcome` = ok/failed/skipped/running, `trigger` = schedule/manual; `total` counts matches. Page numbers, not cursors: at most `SCHEDULE_RUN_HISTORY` (100) runs are kept per schedule |
| GET | `/schedules/:id/runs/:runId` | `Run` |

Schedule: `id, name, cron, timezone, path, url, enabled, nextRunAt,
failing, consecutiveFailures, alertWebhook {set, host}, lastRun (Run|null),
createdAt, updatedAt, links {runNow, runs}`.

Run: `id, trigger (schedule|manual), outcome (running|ok|failed|skipped),
terminal, httpStatus, error, responseExcerpt, startedAt, finishedAt,
durationMs`.

Validation (`400` with `code`): `invalid_cron` (five fields only;
`@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly` are expanded and
stored expanded), `schedule_too_frequent` (any two of the next 60
occurrences closer than `SCHEDULE_MIN_INTERVAL_MS`), `invalid_timezone`
(IANA names), `invalid_path` (must start with `/`, no `//`, whitespace or
fragment), `invalid_alert_webhook`. `409 schedule_limit_reached` beyond
`SCHEDULE_MAX_PER_APP`.

Deploy-declared lists add `invalid_schedules` (not a JSON list of the
right shape) and `duplicate_schedule_path`; there, `schedule_limit_reached`
is a `400` on the deploy.

Audit actions: `schedule.create`, `schedule.update`, `schedule.delete`,
`schedule.run`, `schedule.sync` (a deploy applied its list).

## Dashboard

Added 2026-10-19, read-only (`routes/schedules.routes.ts`, proxy_auth_token):
`GET /companies/:companyId/projects/:projectId/schedules` and
`.../schedules/:scheduleId/runs`, same shapes as the agent API. Every project
response (list, get-one, orphan claim) carries `schedules: {count, failing}`
from one grouped query (`scheduleSummaries`).

The panel (website repo) shows a "Scheduled jobs" section on the app's
Overview, only when it has jobs: timing in words, next run, last run and the
app's reply. A running app with a failing job reads "Needs attention" on its
card and header (`HealthPill`'s `failingJobs`), the section moves to the top,
and the failing job gets "Fix with your AI", a prompt with the job and its last
error (`consoleFixSchedulePrompt`). "All runs" opens every kept run of a job,
20 a page, filterable by result and by what started it
(`ScheduleRunsDialog`). Nothing in the panel changes a schedule.

Alert recipient (fixed 2026-10-19): the app's creator, else the schedule's
creator, skipping stand-ins that aren't people. A deploy-token deploy records
the project's creator as `"hostnsoft-deploy"`, so before this fix alerts for
those apps found no email and were never sent.

## Limits

Same on every plan for now; per-plan limits wait on pricing.

| Setting | Default |
| --- | --- |
| `SCHEDULE_MAX_PER_APP` | 5 |
| `SCHEDULE_MIN_INTERVAL_MS` | 300000 (5 min) |
| `SCHEDULE_RUN_TIMEOUT_MS` | 300000 (5 min) |
| `SCHEDULE_TICK_MS` | 30000 |
| `SCHEDULE_MAX_CONCURRENT_RUNS` | 20 |
| `SCHEDULE_RUN_HISTORY` | 100 runs per schedule |
| `SCHEDULE_RESPONSE_EXCERPT_BYTES` | 2048 |
| `SCHEDULE_TARGET_IP` / `SCHEDULE_TARGET_PORT` | `ORIGIN_SERVER_IP` / 443 |
