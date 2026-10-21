import crypto from "node:crypto";
import { z } from "zod";
import type { AppDetails, Project, ShowcaseEvent, ShowcaseEventListing } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { isUniqueConstraintViolation } from "../lib/prismaErrors";
import type { ProxyUser } from "../lib/msg91";
import { inviteNewContributors, lookupUsersByEmail, mailListingDecision, mailPendingListing, mailPublicListed } from "./showcaseMail";

// Shared by the public/company/admin/agent showcase routers — see
// docs/showcase.md. Two places an app can be shown: the PUBLIC home gallery
// (AppDetails.isPublic) and EVENT pages (ShowcaseEventListing rows).

// ---- types & options

export type ShowcaseType = "public" | "event";

// An event listing's review state. Only approved ones are public.
export const LISTING_STATUSES = ["pending", "approved", "rejected"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const SHOWCASE_CATEGORIES = [
  "AI Tool",
  "Personal",
  "Business",
  "Productivity",
  "Education",
  "Game",
  "Developer Tool",
  "Other",
] as const;
export const SHOWCASE_TOOLS = ["Claude", "Codex", "Cursor", "Lovable", "Replit", "Other"] as const;

// The panel models every place an app is shown as a "page" with an id and a
// slug. The public gallery isn't a row, so it gets this fixed stand-in:
// id "public" in company-scoped routes, empty slug (its URL is /showcase).
export const PUBLIC_PAGE_ID = "public";
export const PUBLIC_PAGE = { slug: "", title: "Embarko Showcase", type: "public" } as const satisfies PageSummary;
export type PageSummary = { slug: string; title: string; type: ShowcaseType };

export function eventSummary(e: Pick<ShowcaseEvent, "slug" | "title">): PageSummary {
  return { slug: e.slug, title: e.title, type: "event" };
}

// ---- event slug

// Reserved: routes that would collide under /showcase/<slug> on the frontend.
const RESERVED_SLUGS = new Set([
  "app", "apps", "submit", "collections", "admin", "api", "new", "edit", "embarko", "hostnsoft",
  "public", "event", "events", "tag", "category",
]);

export const eventSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Slug must be at least 3 characters")
  .max(40, "Slug must be at most 40 characters")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, digits and single dashes only")
  .refine((s) => !RESERVED_SLUGS.has(s), "That slug is reserved");

// ---- submit code

// 8 chars from an alphabet without 0/O/1/I, so it survives being read aloud.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generateSubmitCode(): string {
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

// Optional on every submit: matching the event's code approves at once. A
// wrong code isn't an error — the listing just waits for the organiser.
export const submitCodeSchema = z.string().trim().toUpperCase().max(32).optional();

// Create an event with a fresh code, retrying once if the code collides
// (a slug collision is the caller's 409).
export async function createEvent(data: {
  slug: string;
  title: string;
  intro: string | null;
  customHtml: string | null;
  autoApprove: boolean;
  companyId: string;
  createdBy: string;
}): Promise<ShowcaseEvent> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.showcaseEvent.create({ data: { ...data, submitCode: generateSubmitCode() } });
    } catch (err) {
      if (!isUniqueConstraintViolation(err) || attempt >= 1) throw err;
      if (await prisma.showcaseEvent.findUnique({ where: { slug: data.slug } })) throw err;
    }
  }
}

// ---- app URL

// Not its own config file for one constant — see env.ts for the same pattern.
const APP_PUBLIC_DOMAIN = (process.env.APP_PUBLIC_DOMAIN ?? "embarko.app").replace(/^https?:\/\//, "");

// The hostname an app is served under when it has no custom domain. Exported
// so services/projectSlugChange.ts can recognise (and rewrite) exactly those
// snapshots that point at a slug that just changed.
export function platformAppUrl(slug: string): string {
  return `https://${slug}.${APP_PUBLIC_DOMAIN}`;
}

// The project's active custom domain if it has one, else the platform hostname.
export async function resolveAppUrl(project: Pick<Project, "id" | "slug">): Promise<string> {
  const custom = await prisma.domain.findFirst({
    where: { projectId: project.id, status: "active" },
    orderBy: { createdAt: "asc" },
  });
  return custom ? `https://${custom.domain}` : platformAppUrl(project.slug);
}

// ---- submission input

// `new URL()` accepts javascript:, so the scheme is checked explicitly.
const httpUrl = z
  .string()
  .trim()
  .max(500)
  .refine(
    (raw) => {
      try {
        return ["http:", "https:"].includes(new URL(raw).protocol);
      } catch {
        return false;
      }
    },
    { message: "Must be an http(s) URL" }
  );

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => s || null)
    .nullable()
    .optional();

// Creator- or organiser-supplied HTML, on an app page (AppDetails) or an
// event page (ShowcaseEvent). Stored raw: the panel renders it in a
// sandboxed frame with scripts off, so there is nothing to sanitise here.
export const CUSTOM_HTML_MAX = 50_000;

// An event's HTML, as the edit route takes it: required, "" or null clears.
export const eventCustomHtmlSchema = z.string().trim().max(CUSTOM_HTML_MAX).transform((s) => s || null).nullable();

const optionalUrl = z
  .string()
  .trim()
  .transform((s) => s || null)
  .nullable()
  .optional()
  .pipe(httpUrl.nullable().optional());

const optionalOneOf = (allowed: readonly string[]) =>
  z
    .string()
    .trim()
    .transform((s) => (allowed.includes(s) ? s : null))
    .nullable()
    .optional();

// The app's details — written once per app, reused on every page. Every
// field is optional on the wire: a later submit is a MERGE, so an agent can
// send just a screenshotUrl. Empty string clears a field. name, tagline and
// creatorName are required on the first submit (see upsertAppDetails).
export const appDetailsInputSchema = z.object({
  // Writes Project.name — the app has one name, on the dashboard and here.
  name: z.string().trim().min(1, "App name is required").max(80).optional(),
  tagline: z.string().trim().min(1, "Tell us what it does").max(160).optional(),
  description: optionalText(4000),
  story: optionalText(600),
  creatorName: z.string().trim().min(1, "Creator name is required").max(80).optional(),
  creatorProfile: optionalUrl,
  // "Contact Dev" recipients — one per contributor. Opt-in; [] clears them.
  // contactEmail (one) still accepted as an alias; "" clears.
  contributorEmails: z.array(z.string().trim().toLowerCase().email().max(254)).max(10).optional(),
  contactEmail: z.string().trim().toLowerCase().max(254).transform((s) => s || null).nullable().optional()
    .pipe(z.string().email().nullable().optional()),
  builtWith: optionalOneOf(SHOWCASE_TOOLS),
  category: optionalOneOf(SHOWCASE_CATEGORIES),
  tags: z.array(z.string()).max(20).optional(),
  videoUrl: optionalUrl,
  // Several allowed; screenshotUrl (one) still accepted as an alias.
  screenshotUrls: z.array(httpUrl).max(10).optional(),
  screenshotUrl: optionalUrl,
  customHtml: optionalText(CUSTOM_HTML_MAX),
});
export type AppDetailsInput = z.infer<typeof appDetailsInputSchema>;

// Where to show it: an event's slug, or empty for the public gallery.
const whereSchema = z.union([z.literal(""), eventSlugSchema]).optional().default("");

// Which app: its id, or — since a person usually only has the address —
// its slug, hostname or full URL (appSlug). One of the two is required.
export const showcaseSubmissionSchema = appDetailsInputSchema
  .extend({
    collectionSlug: whereSchema,
    code: submitCodeSchema,
    projectId: z.string().trim().min(1).optional(),
    appSlug: z.string().trim().min(1).max(500).optional(),
  })
  .refine((b) => b.projectId || b.appSlug, { message: "projectId or appSlug is required", path: ["appSlug"] });
export type ShowcaseSubmissionInput = z.infer<typeof showcaseSubmissionSchema>;

// "my-app", "my-app.embarko.app", "https://my-app.embarko.app/x" and a
// custom domain all resolve to the company's project, or null.
export async function findCompanyProject(companyId: string, ref: { projectId?: string; appSlug?: string }): Promise<Project | null> {
  if (ref.projectId) return prisma.project.findFirst({ where: { id: ref.projectId, companyId } });
  if (!ref.appSlug) return null;

  let host = ref.appSlug.toLowerCase().replace(/^https?:\/\//, "").split(/[/?#]/)[0];
  if (host.endsWith(`.${APP_PUBLIC_DOMAIN}`)) host = host.slice(0, -(APP_PUBLIC_DOMAIN.length + 1));
  if (!host.includes(".")) return prisma.project.findFirst({ where: { slug: host, companyId } });

  const domain = await prisma.domain.findFirst({ where: { domain: host, project: { companyId } }, include: { project: true } });
  return domain?.project ?? null;
}

// Same minus projectId: the agent path addresses its app via the deploy
// token + :appName (req.project), not an id it would have to already know.
// ponytail: whatItDoes/whyBuilt are the pre-v3 names the published skill
// still sends; drop the aliases once embarko-ai/skill says description/story.
export const agentShowcaseSubmissionSchema = appDetailsInputSchema
  .extend({ collectionSlug: whereSchema, code: submitCodeSchema })
  .extend({ whatItDoes: optionalText(4000), whyBuilt: optionalText(600) })
  .transform((b) => ({ ...b, description: b.description ?? b.whatItDoes, story: b.story ?? b.whyBuilt }));

export function normalizeTags(raw: string[]): string[] {
  const seen = new Set<string>();
  for (const value of raw) {
    const tag = value
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-");
    if (tag) seen.add(tag);
  }
  return [...seen].slice(0, 8);
}

// ---- writes shared by the dashboard and agent paths

// Where a submission lands. null = unknown event slug.
export type PlaceTarget = { kind: "public" } | { kind: "event"; event: ShowcaseEvent };

export async function resolveTarget(collectionSlug: string): Promise<PlaceTarget | null> {
  if (!collectionSlug) return { kind: "public" };
  const event = await prisma.showcaseEvent.findUnique({ where: { slug: collectionSlug } });
  return event ? { kind: "event", event } : null;
}

export function pageOf(target: PlaceTarget): PageSummary {
  return target.kind === "public" ? PUBLIC_PAGE : eventSummary(target.event);
}

// First submit must carry the fields every card needs (name comes from
// the project).
const firstSubmitSchema = z.object({
  tagline: z.string({ required_error: "Tell us what it does" }),
  creatorName: z.string({ required_error: "Creator name is required" }),
});

// An app's details with the project it belongs to — the slug lives there.
export type AppWithProject = AppDetails & { project: Pick<Project, "slug" | "name"> };
// id + createdBy are for the role check on the owner side (an app the caller
// can't see is filtered out, see routes/showcase.routes.ts); every response
// builder below picks its fields explicitly, so neither leaks into a reply.
export const WITH_PROJECT = { project: { select: { id: true, slug: true, name: true, createdBy: true } } } as const;

// screenshotUrls wins; a lone screenshotUrl means [url], "" means clear.
function screenshotUrlsJson(input: AppDetailsInput): string | undefined {
  if (input.screenshotUrls !== undefined) return JSON.stringify(input.screenshotUrls);
  if (input.screenshotUrl === undefined) return undefined;
  return JSON.stringify(input.screenshotUrl ? [input.screenshotUrl] : []);
}

function contributorEmailsJson(input: AppDetailsInput): string | undefined {
  if (input.contributorEmails !== undefined) return JSON.stringify([...new Set(input.contributorEmails)]);
  if (input.contactEmail === undefined) return undefined;
  return JSON.stringify(input.contactEmail ? [input.contactEmail] : []);
}

// Create or merge the app's one AppDetails row from a submission. Only the
// fields present in the body change (undefined = leave alone, "" = clear),
// so an agent can update a single field. appUrl is re-derived every time.
// Saves the details, then invites contributors listed for the first time on
// this submit who have no Embarko account (showcaseMail.inviteNewContributors).
// `target` only names the page in that mail; placing the app is placeApp's job.
export async function upsertAppDetails(
  project: Pick<Project, "id" | "slug">,
  companyId: string,
  userId: string,
  input: AppDetailsInput,
  target: PlaceTarget
): Promise<AppWithProject> {
  const existing = await prisma.appDetails.findUnique({ where: { projectId: project.id } });
  const saved = await saveAppDetails(project, companyId, userId, input, existing);

  const before = new Set(existing ? parseTags(existing.contributorEmails) : []);
  const added = parseTags(saved.contributorEmails).filter((e) => !before.has(e));
  void inviteNewContributors(added, saved, pageOf(target).title);
  return saved;
}

async function saveAppDetails(
  project: Pick<Project, "id" | "slug">,
  companyId: string,
  userId: string,
  input: AppDetailsInput,
  existing: AppDetails | null
): Promise<AppWithProject> {
  if (input.name) await prisma.project.update({ where: { id: project.id }, data: { name: input.name } });

  const sent = {
    tagline: input.tagline,
    description: input.description,
    story: input.story,
    screenshotUrls: screenshotUrlsJson(input),
    videoUrl: input.videoUrl,
    creatorName: input.creatorName,
    creatorProfile: input.creatorProfile,
    contributorEmails: contributorEmailsJson(input),
    builtWith: input.builtWith,
    category: input.category,
    tagsJson: input.tags === undefined ? undefined : JSON.stringify(normalizeTags(input.tags)),
    customHtml: input.customHtml,
  };
  const fields = {
    ...Object.fromEntries(Object.entries(sent).filter(([, v]) => v !== undefined)),
    appUrl: await resolveAppUrl(project),
  };

  if (existing) return prisma.appDetails.update({ where: { id: existing.id }, data: fields, include: WITH_PROJECT });

  const first = firstSubmitSchema.parse(input);

  // Two submits racing on the same project: whichever row won gets the merge.
  try {
    return await prisma.appDetails.create({
      data: { ...fields, ...first, projectId: project.id, companyId, createdBy: userId },
      include: WITH_PROJECT,
    });
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err;
    const raced = await prisma.appDetails.findUnique({ where: { projectId: project.id } });
    if (!raced) throw err;
    return prisma.appDetails.update({ where: { id: raced.id }, data: fields, include: WITH_PROJECT });
  }
}

// One place an app is shown, in the shape the panel calls a "listing".
export type Placement = {
  id: string;
  page: PageSummary;
  collectionId: string;
  submittedBy: string;
  isHidden: boolean;
  status: ListingStatus;
  rejectionReason: string | null;
  createdAt: Date;
};

export function publicPlacement(app: AppDetails): Placement {
  return {
    id: app.id,
    page: PUBLIC_PAGE,
    collectionId: PUBLIC_PAGE_ID,
    submittedBy: app.createdBy,
    isHidden: false,
    status: "approved",
    rejectionReason: null,
    createdAt: app.createdAt,
  };
}

export function eventPlacement(l: ShowcaseEventListing, event: Pick<ShowcaseEvent, "id" | "slug" | "title">): Placement {
  return {
    id: l.id,
    page: eventSummary(event),
    collectionId: event.id,
    submittedBy: l.addedBy,
    isHidden: l.isHidden,
    status: l.status as ListingStatus,
    rejectionReason: l.rejectionReason,
    createdAt: l.createdAt,
  };
}

// Show the app on the target. `created` is false when it was already there
// (the dashboard 409s on that; the agent path treats it as an update).
// Fire-and-forget mail for a listing whose status this request just set.
function notify(event: ShowcaseEvent, app: AppWithProject, listing: ShowcaseEventListing): void {
  void (listing.status === "pending" ? mailPendingListing(event, app) : mailListingDecision(event, app, listing));
}

// On an event the listing is approved at once when the event auto-approves,
// the code matches, or the app belongs to the organiser; otherwise it waits
// for review. A rejected
// listing submitted again goes back into the queue (or straight in, with
// the code), reason cleared.
export function approvesAtOnce(
  event: Pick<ShowcaseEvent, "autoApprove" | "submitCode" | "companyId">,
  app: Pick<AppDetails, "companyId">,
  code?: string
): boolean {
  return event.autoApprove || (!!code && code === event.submitCode) || app.companyId === event.companyId;
}

export async function placeApp(
  app: AppWithProject,
  target: PlaceTarget,
  userId: string,
  code?: string
): Promise<{ app: AppWithProject; placement: Placement; created: boolean }> {
  if (target.kind === "public") {
    if (app.isPublic) return { app, placement: publicPlacement(app), created: false };
    const updated = await prisma.appDetails.update({ where: { id: app.id }, data: { isPublic: true }, include: WITH_PROJECT });
    void mailPublicListed(updated, userId);
    return { app: updated, placement: publicPlacement(updated), created: true };
  }

  const event = target.event;
  const approved = approvesAtOnce(event, app, code);
  const status: ListingStatus = approved ? "approved" : "pending";

  try {
    const listing = await prisma.showcaseEventListing.create({
      data: { appDetailsId: app.id, eventId: event.id, addedBy: userId, status },
    });
    notify(event, app, listing);
    return { app, placement: eventPlacement(listing, event), created: true };
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err;
    let listing = await prisma.showcaseEventListing.findUniqueOrThrow({
      where: { appDetailsId_eventId: { appDetailsId: app.id, eventId: event.id } },
    });
    if (listing.status === "rejected") {
      listing = await prisma.showcaseEventListing.update({
        where: { id: listing.id },
        data: { status, rejectionReason: null, reviewedBy: null, reviewedAt: null, addedBy: userId },
      });
      notify(event, app, listing);
      return { app, placement: eventPlacement(listing, event), created: true };
    }
    // Pending, and this time the code, ownership or auto-approve clears it.
    if (listing.status === "pending" && approved) {
      listing = await prisma.showcaseEventListing.update({
        where: { id: listing.id },
        data: { status: "approved", reviewedAt: new Date() },
      });
      notify(event, app, listing);
    }
    return { app, placement: eventPlacement(listing, event), created: false };
  }
}

// The one line a submitter (usually an agent) needs after a submit: was it
// an update, is it live, or is it waiting. `pageUrl` is the page's full URL.
export function submitNext(p: Pick<Placement, "status" | "rejectionReason">, pageUrl: string, created: boolean): string {
  const updated = created ? "" : "Details updated. ";
  if (p.status === "approved") return `${updated}Live at ${pageUrl}. Give the person that link.`;
  if (p.status === "pending")
    return `${updated}Awaiting the organiser's approval. It appears at ${pageUrl} once approved; resend with the event's code to skip the wait.`;
  return `${updated}The organiser turned it down${p.rejectionReason ? `: ${p.rejectionReason}` : ""}. Fix that and send again.`;
}

// Every place one app is shown, public first then events newest first.
export function placementsOf(app: AppDetails & { listings: (ShowcaseEventListing & { event: ShowcaseEvent })[] }): Placement[] {
  const out: Placement[] = [];
  if (app.isPublic) out.push(publicPlacement(app));
  for (const l of [...app.listings].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    out.push(eventPlacement(l, l.event));
  }
  return out;
}

// ---- ordering

export const GALLERY_ORDER = [{ featured: "desc" }, { createdAt: "desc" }] as const;

// ---- serialization

export function parseTags(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

// Public shape: no owner, no submitter.
export function toPublicApp(app: AppWithProject, page: PageSummary) {
  return {
    id: app.id,
    slug: app.project.slug,
    name: app.project.name,
    tagline: app.tagline,
    description: app.description,
    story: app.story,
    appUrl: app.appUrl,
    screenshotUrls: parseTags(app.screenshotUrls),
    // ponytail: panel renders one image; drop this once it reads screenshotUrls.
    screenshotUrl: parseTags(app.screenshotUrls)[0] ?? null,
    videoUrl: app.videoUrl,
    creatorName: app.creatorName,
    creatorProfile: app.creatorProfile,
    contributorEmails: parseTags(app.contributorEmails),
    // ponytail: panel reads one address; drop once it reads contributorEmails.
    userEmail: parseTags(app.contributorEmails)[0] ?? null,
    builtWith: app.builtWith,
    category: app.category,
    tags: parseTags(app.tagsJson),
    customHtml: app.customHtml,
    featured: app.featured,
    createdAt: app.createdAt.toISOString(),
    collection: page,
  };
}

// Contributors who have an Embarko account, by name, for the single-app
// page. Nothing is stored: every read asks proxy for each listed address
// in parallel (at most 10 — contributorEmails caps there). An address with
// no account yet is left out and appears the moment its owner signs up; a
// failed lookup drops that one person for this read rather than the page.
// Deliberately not called from list endpoints, which would fan out per app.
export async function resolveContributors(app: Pick<AppDetails, "contributorEmails">): Promise<{ name: string; email: string }[]> {
  const emails = parseTags(app.contributorEmails);
  const users = await lookupUsersByEmail(emails);
  return users.flatMap((u, i) => (u && u !== "unknown" ? [{ name: displayName(u, emails[i]), email: emails[i] }] : []));
}

// Proxy's name, unless it is blank or is itself an address (accounts made by
// publicTokenRequest were saved that way) — then the part before the @.
function displayName(user: ProxyUser, email: string): string {
  const name = user.name.trim();
  return name && !name.includes("@") ? name : email.split("@")[0];
}

// Owner/admin shape: one placement of the app, with provenance and visibility.
export function toOwnerListing(app: AppWithProject, p: Placement) {
  return {
    ...toPublicApp(app, p.page),
    id: p.id,
    createdAt: p.createdAt.toISOString(),
    collectionId: p.collectionId,
    projectId: app.projectId,
    companyId: app.companyId,
    submittedBy: p.submittedBy,
    isPrivate: p.isHidden,
    status: p.status,
    rejectionReason: p.rejectionReason,
    updatedAt: app.updatedAt.toISOString(),
  };
}

// `html` adds the event's customHtml. Only the single-event reads ask for
// it: lists (the submit form's page picker, the console and admin lists)
// would otherwise carry up to 50k per event that nothing on them shows.
type EventShapeOptions = { html?: boolean };
const eventHtml = (e: ShowcaseEvent, opts: EventShapeOptions) => (opts.html ? { customHtml: e.customHtml } : {});

export function toPublicEvent(e: ShowcaseEvent, projectCount: number, opts: EventShapeOptions = {}) {
  return {
    slug: e.slug,
    title: e.title,
    intro: e.intro,
    ...eventHtml(e, opts),
    type: "event" as const,
    autoApprove: e.autoApprove,
    projectCount,
    createdAt: e.createdAt.toISOString(),
  };
}

// total = every listing; publicCount = approved and not hidden; pending = awaiting review.
export type EventCounts = { total: number; publicCount: number; pending: number };

// Owner/admin shape — adds ownership. Never public.
export function toOwnerEvent(e: ShowcaseEvent, counts: EventCounts, opts: EventShapeOptions = {}) {
  return {
    id: e.id,
    slug: e.slug,
    title: e.title,
    intro: e.intro,
    ...eventHtml(e, opts),
    type: "event" as const,
    companyId: e.companyId,
    createdBy: e.createdBy,
    submitCode: e.submitCode,
    autoApprove: e.autoApprove,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    counts,
  };
}

// The public gallery in the owner "page" shape, for a company: how many of
// its apps are public. Lets the panel keep one code path for every page.
export function toOwnerPublicPage(companyId: string, publicApps: number, since: Date) {
  return {
    id: PUBLIC_PAGE_ID,
    ...PUBLIC_PAGE,
    intro: null,
    companyId,
    createdBy: "",
    createdAt: since.toISOString(),
    updatedAt: since.toISOString(),
    counts: { total: publicApps, publicCount: publicApps, pending: 0 },
  };
}

// One grouped query for a batch of events, for list and detail views.
export async function eventCounts(eventIds: string[]): Promise<Map<string, EventCounts>> {
  const map = new Map<string, EventCounts>();
  for (const id of eventIds) map.set(id, { total: 0, publicCount: 0, pending: 0 });
  if (eventIds.length === 0) return map;

  const rows = await prisma.showcaseEventListing.groupBy({
    by: ["eventId", "isHidden", "status"],
    where: { eventId: { in: eventIds } },
    _count: { _all: true },
  });
  for (const r of rows) {
    const c = map.get(r.eventId)!;
    c.total += r._count._all;
    if (r.status === "approved" && !r.isHidden) c.publicCount += r._count._all;
    if (r.status === "pending") c.pending += r._count._all;
  }
  return map;
}
