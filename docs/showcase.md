# Showcase — public gallery, event pages, approvals

**Added 2026-09-15; reworked 2026-09-30 (v3: `AppDetails`, public flag,
events; company pages removed) plus event approvals and a submit code.**
Single reference for the feature.

Embarko Showcase (`embarko.ai/showcase`) is a public gallery of apps built
with AI agents. A listing is a page about one app at `/showcase/app/<slug>`:
what it does, who built it, screenshots, link to the live app. Indexed by
search engines. An app is described once (`AppDetails`), then shown on:

| Page | Where | Live |
| --- | --- | --- |
| Public | `/showcase` (a flag on the app) | at once |
| Event | `/showcase/<event-slug>`, made by a company for a hackathon or demo day | when the organiser approves, or at once with the event's code or if the app is the organiser's own |

Submissions come mostly from the **agent** that deployed the app (deploy
token); the console form does the same.

## Roles

| Role | Who | Does |
| --- | --- | --- |
| Agent | The coding agent holding the app's deploy token | Submits to the gallery or an event, with or without the code. Updates details later, even one field. |
| App owner | Members of the app's company | Sees placements and status, withdraws, can submit from the console. |
| Organiser | Members of the event's company | Sees the code, approves / rejects (optional reason), hides / removes. |
| Super admin | Embarko staff | Features apps on the gallery. Nothing else. |

## Tables

### `AppDetails` — one row per deployed app

| Column | Notes |
| --- | --- |
| projectId | `Project.id`, unique; relation to `Project`, cascade. The Showcase address is `/showcase/app/<Project.slug>` — no slug copy here, so it follows a rename. |
| companyId, createdBy | Owner company and first writer. |
| tagline, creatorName | Required on the first submit only. `name` in the body writes `Project.name`; replies read it from there. |
| description, story, creatorProfile | Optional. |
| contributorEmails | JSON `string[]`, max 10, opt-in — everyone who built the app, the person showcasing it first (the main contact). Input `contributorEmails[]`, or `contactEmail` as a one-item alias. Returned as `contributorEmails` plus `userEmail` (the first); the panel's server-side contact route reads it for "Contact Dev" and strips it before render. |
| appUrl | Active custom domain, else `https://<slug>.<APP_PUBLIC_DOMAIN>`. Never typed; re-derived each submit, repointed by `services/projectSlugChange.ts` on rename. |
| screenshotUrls, videoUrl | Optional. JSON-encoded `string[]`, max 10; returned as `screenshotUrls` plus `screenshotUrl` (the first) for the panel, which shows one and only apps that have it. Input `screenshotUrls[]`, or `screenshotUrl` as a one-item alias. |
| builtWith | `SHOWCASE_TOOLS`: Claude, Codex, Cursor, Lovable, Replit, Other. |
| category | `SHOWCASE_CATEGORIES`: AI Tool, Personal, Business, Productivity, Education, Game, Developer Tool, Other. |
| tagsJson | JSON `string[]`, normalised, max 8. |
| customHtml | Raw HTML for the app page (panel sanitises). |
| isPublic, featured | On the gallery; admin's "first in gallery" flag. |

### `ShowcaseEvent` — one event page

| Column | Notes |
| --- | --- |
| slug | Unique, immutable, `^[a-z0-9]+(-[a-z0-9]+)*$`, 3–40 chars, not reserved (`app`, `apps`, `public`, `event`, …). |
| title, intro, companyId, createdBy | |
| submitCode | 8 chars, no 0/O/1/I, unique, generated on create. Given on submit, skips approval. |

### `ShowcaseEventListing` — one app on one event

| Column | Notes |
| --- | --- |
| appDetailsId, eventId | Unique together; cascade on delete. |
| addedBy | Submitting user (or deploy-token owner). |
| status | `pending` / `approved` / `rejected` (`LISTING_STATUSES`; no SQLite enums). Only `approved` is public. |
| rejectionReason, reviewedBy, reviewedAt | Set on review; reason cleared on resubmit. |
| isHidden | Organiser's soft switch on an approved listing. |

Index `[eventId, status, isHidden]` serves the public reads.

**The "public page":** company routes present the gallery as a page with
id `public`, slug `""`, title "Embarko Showcase", `type: "public"`; its
"listings" are the company's public apps with `id = AppDetails.id`.
Events have `type: "event"`.

## Flow

```
organiser: POST .../collections {slug, title, intro}
           → live, empty; submitCode in the reply and on the console page
           → shares the code (or the "add your app" prompt, which carries it)

agent:     PUT /apps/<name>/showcase {details, collectionSlug?, code?}
           → AppDetails created, or MERGED (only sent fields change)
           ├─ no collectionSlug ─────────────────────────► isPublic → live
           └─ event
                ├─ code matches / app's company == organiser ► approved → live
                └─ no or wrong code ─────────────────────► pending (not public)

organiser: PATCH .../projects/:listingId {approve} | {reject, reason?}
           then hide / unhide / remove on approved listings
```

- Submitting an already-listed app is a success: details merge, `next`
  says "Details updated…". Same app can be public and on many events.
- A rejected app resubmitted goes back to `pending` (or `approved` with the
  code / own company), reason cleared. A wrong code is never an error.
- Public: `/showcase` = `isPublic`, featured first then newest;
  `/showcase/<event>` = approved and not hidden; `/showcase/app/<slug>` = the
  app if public or on any event with an approved visible listing, else 404.
- Mails (`services/showcaseMail.ts`, viasocket flow, failures only logged):
  listing enters `pending` → event creator; listing becomes `approved` /
  `rejected` (reviewed or auto), or app first goes on the public gallery →
  `contributorEmails`, else the submitter.
  Re-submitting a still-pending listing without the code mails nobody.
- Owner: every placement with `status` / `rejectionReason`. **Withdraw**
  flips `isPublic` off or deletes the event listing; `AppDetails` stays.

## Endpoints

### Public (no auth) — `src/routes/publicShowcase.routes.ts`

Mounted before the docs router and every `requireProxyToken` router.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/public/showcase?limit=60` | Public apps, featured first then newest. |
| GET | `/public/showcase/collections/:slug` | `{collection, projects}`, approved and not hidden. 404 unknown slug; an empty event resolves. |
| GET | `/public/showcase/apps/:slug` | One app with `customHtml`, `userEmail`. `collection` is the public stand-in when public, else its first visible event. |

### Agent (deploy token) — `src/routes/agentApps.routes.ts`

| Method | Path | Notes |
| --- | --- | --- |
| PUT | `/apps/:appName/showcase` | App from the token + `:appName`. 201 newly placed (or revived from rejected), 200 already there (merged). Reply: the listing + `status` + one-line `next` ("Live at …" followed by promotion guidance, which also asks for a demo video when `videoUrl` is empty; "Awaiting the organiser's approval…"; or the rejection reason; "Details updated." prefix on 200). 404 `SHOWCASE_COLLECTION_UNKNOWN`. |

**Body** (agent and console): `collectionSlug` (absent/`""` = gallery),
`code`, `name`, `tagline`, `creatorName`, `description`, `story`,
`creatorProfile`, `contributorEmails[]` (or `contactEmail`), `builtWith`, `category`, `tags[]`, `screenshotUrls[]` (or `screenshotUrl`),
`videoUrl`, `customHtml`. **Merge semantics:** absent = untouched,
`""` = cleared; `tagline`/`creatorName` required on first submit only; `name` updates `Project.name`.
`whatItDoes`/`whyBuilt` still accepted as aliases for the older skill.
Validation (`appDetailsInputSchema`): http(s) URLs, unknown
`builtWith`/`category` dropped, tags capped at 8, `customHtml` ≤ 50k.

```bash
curl -X PUT "https://ship.embarko.ai/api/apps/my-app/showcase" \
  -H "Authorization: Bearer $DEPLOY_TOKEN" -H "Content-Type: application/json" \
  -d '{"collectionSlug":"walkover","code":"Z3H63FRD","name":"My App","tagline":"One line","creatorName":"Jane"}'
```

### Company (proxy token + membership) — `src/routes/showcase.routes.ts`

All under `/companies/:companyId/showcase/…`, scoped by `companyId` (404 otherwise).

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/collections` `{slug, title, intro?}` | Create event; reply has `submitCode`. 409 `SHOWCASE_SLUG_TAKEN`. |
| GET | `/collections` | Public stand-in first, then own events with `submitCode`, `counts: {total, publicCount, pending}`. |
| GET | `/collections/:id` | Plus `projects[]` with `status`, `rejectionReason` (every status for an event). |
| DELETE | `/collections/:id` | Events only (409 `SHOWCASE_PUBLIC_PAGE`), while empty (409 `SHOWCASE_COLLECTION_NOT_EMPTY`). |
| PATCH | `/collections/:id/projects/:listingId` `{approve}` / `{reject, reason?}` / `{isPrivate}` / `{remove}` | Event: review a pending listing (409 `SHOWCASE_LISTING_NOT_PENDING` otherwise), hide/unhide (200), remove (204). Public page: hide/remove unpublishes own app, unhide republishes; review 409 `SHOWCASE_PUBLIC_PAGE`. |
| GET | `/pages` | Where an app can go: public stand-in, then every event. |
| POST | `/submissions` | Agent body + `projectId` **or** `appSlug` (slug, `<slug>.embarko.app`, URL, or custom domain). Same 201/200 replies with `status` (no `next`; that is agent-only). Resending `{collectionSlug, projectId, code}` for a pending listing approves it when the code matches — the UI's "enter event code" uses this, no separate endpoint. |
| GET | `/submissions?projectId=` | Every placement of the company's apps, with status. |
| DELETE | `/submissions/:listingId` | Withdraw. `listingId` = `AppDetails` id (public) or event listing id. |

### Admin (super admin) — `src/routes/adminShowcase.routes.ts`

404, never 403, for non-admins.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/showcase/collections?q=&page=&limit=` | Every event, with `companyName`. |
| GET | `/admin/showcase/projects?collectionId=&q=&page=&limit=` | Every app with details and listing `status`. `collectionId=public` or an event id narrows. |
| PATCH | `/admin/showcase/projects/:id` `{featured}` | The only admin lever. No admin approve. |

Audit: `showcase.event.create/delete`, `showcase.public.add/remove`,
`showcase.listing.create/update/withdraw/approve/reject/hide/show/remove`.

## Config

| Env | Default | Purpose |
| --- | --- | --- |
| `APP_PUBLIC_DOMAIN` | `embarko.app` | Derives `appUrl`. |
| `FRONTEND_ORIGIN` | `http://localhost:3000` | Page link in the reply's `next`. |

## Frontend (hostnsoft)

- Public `app/showcase/*` reads `/public/showcase/*` via `app/lib/showcase.ts`,
  filtering out apps without a screenshot. The app page's "Contact Dev"
  form posts to `app/api/showcase/contact`, which reads `userEmail`
  server-side and relays to `POST /public/customer-query` with `toEmail`,
  `name`, `appSlug`. The API mails the developer through the viasocket flow
  (`Webhook.SHOWCASE_CONTACT_EMAIL`) to every address in that app's
  `contributorEmails` only when `toEmail` is one of them (404 `SHOWCASE_NO_CONTACT` otherwise), and keeps a
  customer-query row for admins.
- Console `/app/showcase`: public stand-in, events with a "N to review" tag,
  create event. `/app/showcase/<id>`: submit code (copyable), "Requests"
  with Approve / Reject (optional reason), then listed apps with
  hide/show/remove. `/app/showcase/submit`: gallery or event (optional code
  field) → app → details. Owner's app page shows status and reason.
- `app/lib/showcasePrompt.ts` carries the code when the organiser shares
  the prompt and tells the agent to report "awaiting approval".
- Admin `/admin/showcase`: events, apps with status, feature toggle.
- Agent docs: `content/docs/api.md` (#showcase), `content/docs/docs.md`.

## Migrations

- `20261001090000_drop_app_details_name`: drops `AppDetails.name`; the name is `Project.name`.
- `20260930090000_showcase_v3`: drops `ShowcaseCollection` / `ShowcaseProject`
  (no data carried), creates the three tables with the approval columns and
  `submitCode`; company pages and their auto-creation hooks removed.

## Deliberately not done

- No admin edit / approve / hide; no notifications; no code rotation; no
  per-event "approval off" switch.
- `customHtml` stored raw; the panel sanitises on render.
- No spam control beyond approval, the hide switch, and every submitter
  being a logged-in member or deploy token with a real project.
