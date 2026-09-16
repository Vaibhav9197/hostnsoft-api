# Showcase — a reserved page per company, open public boards, apps listed by their owners

**Added 2026-09-15; approval and submission codes removed 2026-09-16.**
Showcase lets companies show off the apps they built and deployed on
Embarko. Two kinds of public page, both at `/showcase/<slug>`:

- **Company page** (`type: "company"`) — reserved for every company the
  moment it is created, slug derived from its name. Only that company's
  own deployed apps can be listed on it.
- **Public board** (`type: "public"`) — created by a company from its console
  (a hackathon, a demo day). Live at once. Members of **any** company list
  their **own deployed apps** on it by picking the page.

There is no admin approval, no submission code, no anonymous form and no
per-app review. Listings go live the moment they are made.

## Vocabulary

| Term | Model | What it is |
| --- | --- | --- |
| Collection | `ShowcaseCollection` | A public page `/showcase/<slug>`, owned by a company (`companyId`). `type` is `company` or `public`. Slug globally unique and immutable. |
| Listing | `ShowcaseProject` | One deployed app (`projectId` → `Project.id`) listed under one collection by a member (`submittedBy`) of the app's company (`companyId`). `appUrl` is derived from the project, never typed. Unique per `(collectionId, projectId)`. |

### The company page

Created by `ensureCompanyCollection` (`src/services/showcase.ts`) from two
places:

- `POST /companies` — right after proxy creates the company. Best effort:
  a failure is logged and the response carries `showcaseSlug: null`.
- `loadCompanyContext` (`src/middleware/companyContext.ts`) — every
  company-scoped request passes through it, whichever way the company
  became active in the dashboard (login default, stored choice, or a
  switch; the dashboard picks locally and only tells the API best-effort).
  So a company that predates Showcase, or one proxy made itself, gets its
  page on the first scoped request made for it.

The middleware path goes through `hasCompanyPage` / `ensureCompanyPage`,
which never throw and cache "already has a page" in Redis for a day, so
the steady-state cost is one Redis read per request. Idempotent: one `company` collection per
`companyId`, found by `findFirst` before any create, with a unique-slug
race absorbed by a retry.
The slug is the company name slugified (`walkover-web-solutions`), suffixed
`-2`, `-3`… when taken; a name that yields nothing usable (too short, or a
reserved word like `admin`) falls back to `company-<companyId>`.

Title is the company name, `intro` null. The company page can't be
deleted (409 `SHOWCASE_COMPANY_PAGE`); it is the company's address.

### Public boards

`POST /companies/:companyId/showcase/collections {slug, title, intro?}`.
No limit per company. Deletable only while empty. Anyone may list on them.

### Who can list where

`canListOn(collection, companyId)`: **public → anyone; company → only the
owner.** Enforced in `POST .../submissions` (403
`SHOWCASE_COLLECTION_PRIVATE`). The submitter names the page by slug
(`collectionSlug`), and the picker is fed by `GET .../showcase/pages`.

### Listings and visibility

A listing has no review state. One switch decides whether it is public:

| Field | Set by | Effect |
| --- | --- | --- |
| `isPrivate` on the listing | the **collection's owner** | Hides it from every public route without removing it. The app's owner still sees it (marked hidden) in their own console. |

**Public ⇔ `isPrivate == false`.** Every public read applies exactly this
(`PUBLIC_WHERE` in `src/services/showcase.ts`).

The app's owner can **withdraw** a listing (`DELETE .../submissions/:id`),
and the collection's owner can **remove** it from their page (`PATCH …
{remove: true}`); both delete the row. `featured` (admin) orders a listing ahead of the rest.

`appUrl` is snapshotted at listing time by `resolveAppUrl`: the project's
active custom domain if it has one, else `https://<slug>.<APP_PUBLIC_DOMAIN>`.

## Flow

```
organiser (console)                       app owner (console, any company)
──────────────────                        ────────────────────────────────
(company page exists since signup:
 /showcase/walkover)

POST .../showcase/collections
  {slug:"iit-indore-2026", title}
  → live at once, type public
                                          GET .../showcase/pages
                                            → own company page + every public board
                                          POST .../showcase/submissions
                                            {collectionSlug:"iit-indore-2026", projectId (own app), name, tagline, …}
                                            → live at once
GET .../collections/:id
  sees the listing
PATCH .../collections/:id/projects/:listingId
  {isPrivate:true}  ← optional
                                          GET /showcase/iit-indore-2026 shows it (unless hidden)
                                          DELETE .../showcase/submissions/:id ← withdraw
```

## Endpoints

### Public (no auth) — `src/routes/publicShowcase.routes.ts`

Reads only. Mounted before the docs router (which serves `GET /public/:slug`)
and before every `requireProxyToken` router — see `routes/index.ts`. No
rate limiting anywhere in Showcase: every write is behind a verified proxy
identity.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/public/showcase?limit=60` | Public listings, featured first then newest. |
| GET | `/public/showcase/collections` | Collections with ≥1 public listing (the gallery's discover rail). Each carries `type`. |
| GET | `/public/showcase/collections/:slug` | `{collection, projects}`. 404 for an unknown slug; an empty page still resolves. |
| GET | `/public/showcase/apps/:slug` | One listing. Hidden 404s like an unknown one. |

### Company (proxy token + company membership) — `src/routes/showcase.routes.ts`

All under `/companies/:companyId/showcase/…`, every lookup scoped by
`companyId` so another company's ids 404.

**As organiser** (pages this company owns):

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/collections` `{slug, title, intro?}` | Create a public board, live at once. 409 `SHOWCASE_SLUG_TAKEN` if anyone holds the slug. Slug: `^[a-z0-9]+(-[a-z0-9]+)*$`, 3–40 chars, not reserved (`apps`, `submit`, …). |
| GET | `/collections` | Company page first, then public boards, each with `type` and `counts: {total, publicCount}`. |
| GET | `/collections/:collectionId` | Plus `projects[]` — every listing, hidden or not. |
| DELETE | `/collections/:collectionId` | Public boards only (409 `SHOWCASE_COMPANY_PAGE`), and only while nothing is listed (409 `SHOWCASE_COLLECTION_NOT_EMPTY`). |
| PATCH | `/collections/:collectionId/projects/:listingId` `{isPrivate}` or `{remove: true}` | Hide/unhide someone's listing on this page (200), or remove it from the page outright (204). One route for both organiser levers. |

**As submitter** (own apps):

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/pages` | Every page this company may list on: its own company page plus every public board (including empty ones). Public shape. |
| POST | `/submissions` | Body: `collectionSlug, projectId, name, tagline, creatorName` required; `whatItDoes, whyBuilt, creatorProfile, builtWith, category, tags[], videoUrl, screenshotUrl` optional. 404 `SHOWCASE_COLLECTION_UNKNOWN` for an unknown slug; 403 `SHOWCASE_COLLECTION_PRIVATE` for another company's company page. `projectId` must be one of `:companyId`'s projects (404 otherwise). 409 `SHOWCASE_ALREADY_LISTED` if that app is already under that slug. 201 with the listing. |
| GET | `/submissions?projectId=` | Every listing this company has made, any page; `projectId` narrows to one app (its settings page). |
| DELETE | `/submissions/:listingId` | Withdraw. |

Validation lives in `showcaseSubmissionSchema` (`src/services/showcase.ts`):
every URL must parse as http(s), `builtWith`/`category` must be offered
options or are dropped, tags normalised and capped at 8.

### Admin (proxy token + super admin) — `src/routes/adminShowcase.routes.ts`

Same gate as `admin.routes.ts`: 404, never 403, for non-admins. Oversight
only; nothing here approves anything.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/showcase/collections?type=&q=&page=&limit=` | Every page, paginated `{items, page, limit, total, totalPages}`, each with `companyName` (via proxy, TTL-cached). |
| GET | `/admin/showcase/projects?collectionId=&q=&page=&limit=` | Every listing, with `submitterCompany`, `ownerCompany`. |
| PATCH | `/admin/showcase/projects/:id` `{featured}` | The admin's one lever on a listing. |

Every mutating company action writes an `AuditLog` row
(`showcase.collection.create/delete`,
`showcase.listing.create/withdraw/hide/show/remove`). Company-page reservation
is not audited: it is a side effect of company creation, not a user action.

## Config

| Env | Default | Purpose |
| --- | --- | --- |
| `APP_PUBLIC_DOMAIN` | `app.embarko.ai` | Hostname deployed apps are served under as `<slug>.<domain>`; used to derive `appUrl`. Read directly in `resolveAppUrl` (`src/services/showcase.ts`) — no dedicated config file for one constant. |

## Frontend (hostnsoft)

- Public pages (`app/showcase/*`) read `/public/showcase/*` server-side via
  `app/lib/showcase.ts`. `/showcase/<slug>` is the collection page. Every
  "list your app" CTA points at the console.
- Console `/app/showcase`: the company's own page, "create a public board"
  form, plus "Your listed apps" with withdraw. `/app/showcase/<collectionId>`:
  the page's listings with hide/show. `/app/showcase/submit`: pick a page
  from `GET .../showcase/pages` (or arrive with `?page=<slug>`) → pick one
  of the company's deployed apps → details → live.
- Admin `/admin/showcase`: "Pages" tab (type filter, search) and "Listed
  apps" tab (feature).

## Migration note (2026-09-16)

`20260916120000_showcase_open_pages` drops `status`, `reviewedAt`,
`reviewedBy`, `rejectionReason` and `token`, and adds `type` defaulting to
`public`. Every collection that existed before — pending or rejected
included — is therefore a live public board after the migration. Company
pages for existing companies are created lazily, on the first
company-scoped request the dashboard makes for them.

## Deliberately not done

- No admin edit of a listing's content, and no admin hide — the organiser
  hides or removes, the owner withdraws.
- No editing a listing or a page's title/intro after it's made.
- No spam control on public boards beyond the organiser's hide switch and
  the fact that every submitter is a logged-in company member with a real
  deployed project.
