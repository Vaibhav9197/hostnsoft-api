import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { isUniqueConstraintViolation } from "../lib/prismaErrors";
import { requireProxyToken } from "../middleware/proxyToken";
import { loadCompanyContext } from "../middleware/companyContext";
import { logAudit } from "../services/audit";
import { FRONTEND_ORIGIN } from "../lib/frontendOrigin";
import {
  PUBLIC_PAGE,
  PUBLIC_PAGE_ID,
  WITH_PROJECT,
  createEvent,
  eventCounts,
  eventPlacement,
  eventSlugSchema,
  findCompanyProject,
  placeApp,
  placementsOf,
  publicPlacement,
  resolveTarget,
  showcaseSubmissionSchema,
  submitNext,
  toOwnerEvent,
  toOwnerListing,
  toOwnerPublicPage,
  toPublicEvent,
  upsertAppDetails,
} from "../services/showcase";

// Company half of Showcase — see docs/showcase.md. A logged-in member of
// :companyId acts as ORGANISER of the event pages it created and as
// SUBMITTER of this company's apps onto the public gallery or any event.
// Every lookup scoped by companyId.
//
// The public gallery is addressed as page id "public" so the panel can treat
// it like any other page: its "listings" are this company's public apps.
export const showcaseRouter = Router();
showcaseRouter.use(requireProxyToken);

async function ownedEventOr404(req: Request, res: Response) {
  const event = await prisma.showcaseEvent.findFirst({ where: { id: req.params.collectionId, companyId: req.company!.id } });
  if (!event) res.status(404).json({ error: "Collection not found" });
  return event;
}

function audit(req: Request, action: string, details: string, projectId?: string) {
  return logAudit({ actorUserId: req.userId, companyId: req.company!.id, projectId, action, details });
}

// This company's public apps, in the shape of a page's listings.
async function publicPage(companyId: string) {
  const apps = await prisma.appDetails.findMany({ where: { companyId, isPublic: true }, orderBy: { createdAt: "desc" }, include: WITH_PROJECT });
  const since = apps.length ? apps[apps.length - 1].createdAt : new Date(0);
  return { page: toOwnerPublicPage(companyId, apps.length, since), apps };
}

// =========================================================== organiser side

const createEventSchema = z.object({
  slug: eventSlugSchema,
  title: z.string().trim().min(1).max(80),
  intro: z.string().trim().max(600).optional().nullable(),
});

// POST .../collections — create an event page. Live at once, open to every company's apps.
showcaseRouter.post("/companies/:companyId/showcase/collections", loadCompanyContext, async (req, res) => {
  const body = createEventSchema.parse(req.body);
  try {
    const event = await createEvent({ ...body, intro: body.intro ?? null, companyId: req.company!.id, createdBy: req.userId! });
    await audit(req, "showcase.event.create", event.slug);
    res.status(201).json(toOwnerEvent(event, { total: 0, publicCount: 0, pending: 0 }));
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      return res.status(409).json({ error: "That slug is already taken", code: "SHOWCASE_SLUG_TAKEN" });
    }
    throw err;
  }
});

// GET .../collections — the public gallery entry first, then this company's events.
showcaseRouter.get("/companies/:companyId/showcase/collections", loadCompanyContext, async (req, res) => {
  const [{ page }, events] = await Promise.all([
    publicPage(req.company!.id),
    prisma.showcaseEvent.findMany({ where: { companyId: req.company!.id }, orderBy: { createdAt: "desc" } }),
  ]);
  const counts = await eventCounts(events.map((e) => e.id));
  res.json([page, ...events.map((e) => toOwnerEvent(e, counts.get(e.id)!))]);
});

// GET .../collections/:collectionId — plus everything listed under it, hidden or not.
showcaseRouter.get("/companies/:companyId/showcase/collections/:collectionId", loadCompanyContext, async (req, res) => {
  if (req.params.collectionId === PUBLIC_PAGE_ID) {
    const { page, apps } = await publicPage(req.company!.id);
    return res.json({ ...page, projects: apps.map((a) => toOwnerListing(a, publicPlacement(a))) });
  }

  const event = await ownedEventOr404(req, res);
  if (!event) return;
  const [listings, counts] = await Promise.all([
    prisma.showcaseEventListing.findMany({ where: { eventId: event.id }, orderBy: { createdAt: "desc" }, include: { app: { include: WITH_PROJECT } } }),
    eventCounts([event.id]),
  ]);
  res.json({
    ...toOwnerEvent(event, counts.get(event.id)!),
    projects: listings.map((l) => toOwnerListing(l.app, eventPlacement(l, event))),
  });
});

// DELETE .../collections/:collectionId — events only, and only while empty.
showcaseRouter.delete("/companies/:companyId/showcase/collections/:collectionId", loadCompanyContext, async (req, res) => {
  if (req.params.collectionId === PUBLIC_PAGE_ID) {
    return res.status(409).json({ error: "The public gallery can't be deleted", code: "SHOWCASE_PUBLIC_PAGE" });
  }
  const event = await ownedEventOr404(req, res);
  if (!event) return;

  const listed = await prisma.showcaseEventListing.count({ where: { eventId: event.id } });
  if (listed > 0) {
    return res.status(409).json({ error: "Apps are listed under this page; it can't be deleted", code: "SHOWCASE_COLLECTION_NOT_EMPTY" });
  }
  await prisma.showcaseEvent.delete({ where: { id: event.id } });
  await audit(req, "showcase.event.delete", event.slug);
  res.status(204).end();
});

// Every organiser lever on a listing goes through one route, so the console
// needs no second endpoint: review it, flip visibility, or remove outright.
const updateListingSchema = z.union([
  z.object({ isPrivate: z.boolean() }),
  z.object({ remove: z.literal(true) }),
  z.object({ approve: z.literal(true) }),
  z.object({ reject: z.literal(true), reason: z.string().trim().max(500).optional() }),
]);

// PATCH .../collections/:collectionId/projects/:listingId
//   {approve:true}         — a pending listing goes live (200, the listing)
//   {reject:true, reason?} — a pending listing is turned down; the owner sees the reason (200)
//   {isPrivate}            — organiser hides/unhides a listing (200, the listing)
//   {remove:true}          — organiser takes it off the page for good (204)
// On the public page both mean the same thing for one of this company's own
// apps: hide/remove unpublishes it, unhide republishes it.
showcaseRouter.patch(
  "/companies/:companyId/showcase/collections/:collectionId/projects/:listingId",
  loadCompanyContext,
  async (req, res) => {
    const body = updateListingSchema.parse(req.body);

    if (req.params.collectionId === PUBLIC_PAGE_ID) {
      if ("approve" in body || "reject" in body) {
        return res.status(409).json({ error: "The public gallery has no approval step", code: "SHOWCASE_PUBLIC_PAGE" });
      }
      const app = await prisma.appDetails.findFirst({ where: { id: req.params.listingId, companyId: req.company!.id } });
      if (!app) return res.status(404).json({ error: "Listing not found" });
      const isPublic = "remove" in body ? false : !body.isPrivate;
      const updated = await prisma.appDetails.update({ where: { id: app.id }, data: { isPublic }, include: WITH_PROJECT });
      await audit(req, isPublic ? "showcase.public.add" : "showcase.public.remove", updated.project.slug, app.projectId);
      if ("remove" in body) return res.status(204).end();
      return res.json(toOwnerListing(updated, publicPlacement(updated)));
    }

    const event = await ownedEventOr404(req, res);
    if (!event) return;
    const existing = await prisma.showcaseEventListing.findFirst({
      where: { id: req.params.listingId, eventId: event.id },
      include: { app: { include: WITH_PROJECT } },
    });
    if (!existing) return res.status(404).json({ error: "Listing not found" });

    if ("approve" in body || "reject" in body) {
      if (existing.status !== "pending") {
        return res.status(409).json({ error: "That listing has already been reviewed", code: "SHOWCASE_LISTING_NOT_PENDING" });
      }
      const approve = "approve" in body;
      const updated = await prisma.showcaseEventListing.update({
        where: { id: existing.id },
        data: {
          status: approve ? "approved" : "rejected",
          rejectionReason: approve ? null : body.reason || null,
          reviewedBy: req.userId!,
          reviewedAt: new Date(),
        },
      });
      await audit(req, approve ? "showcase.listing.approve" : "showcase.listing.reject", `${existing.app.project.slug} @ /showcase/${event.slug}`, existing.app.projectId);
      return res.json(toOwnerListing(existing.app, eventPlacement(updated, event)));
    }

    if ("remove" in body) {
      await prisma.showcaseEventListing.delete({ where: { id: existing.id } });
      await audit(req, "showcase.listing.remove", `${existing.app.project.slug} <- /showcase/${event.slug}`, existing.app.projectId);
      return res.status(204).end();
    }

    const updated = await prisma.showcaseEventListing.update({ where: { id: existing.id }, data: { isHidden: body.isPrivate } });
    await audit(req, body.isPrivate ? "showcase.listing.hide" : "showcase.listing.show", `${existing.app.project.slug} @ /showcase/${event.slug}`);
    res.json(toOwnerListing(existing.app, eventPlacement(updated, event)));
  }
);

// =========================================================== submitter side

// GET .../pages — every page this company may list an app on: the public
// gallery first, then every event, newest first. Feeds the submit form.
showcaseRouter.get("/companies/:companyId/showcase/pages", loadCompanyContext, async (req, res) => {
  const [publicCount, events] = await Promise.all([
    prisma.appDetails.count({ where: { isPublic: true } }),
    prisma.showcaseEvent.findMany({ orderBy: { createdAt: "desc" } }),
  ]);
  const counts = await eventCounts(events.map((e) => e.id));
  res.json([
    { ...PUBLIC_PAGE, intro: null, projectCount: publicCount, createdAt: new Date(0).toISOString() },
    ...events.map((e) => toPublicEvent(e, counts.get(e.id)!.publicCount)),
  ]);
});

const COLLECTION_UNKNOWN = { error: "That showcase page doesn't exist", code: "SHOWCASE_COLLECTION_UNKNOWN" } as const;

// POST .../submissions — show one of this company's own apps on the public
// gallery (no collectionSlug) or on the named event. The app is named by
// projectId or appSlug (slug, hostname or URL). Live at once. The app's
// details are written once and refreshed on every submit.
showcaseRouter.post("/companies/:companyId/showcase/submissions", loadCompanyContext, async (req, res) => {
  const body = showcaseSubmissionSchema.parse(req.body);

  const target = await resolveTarget(body.collectionSlug);
  if (!target) return res.status(404).json(COLLECTION_UNKNOWN);

  const project = await findCompanyProject(req.company!.id, body);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const app = await upsertAppDetails(project, req.company!.id, req.userId!, body);
  const placed = await placeApp(app, target, req.userId!, body.code);
  const where = target.kind === "public" ? "/showcase" : `/showcase/${target.event.slug}`;

  // Already there = an update of its details, not an error: the same call
  // is how an agent fixes a tagline or adds a screenshot.
  await audit(
    req,
    placed.created ? (target.kind === "public" ? "showcase.public.add" : "showcase.listing.create") : "showcase.listing.update",
    `${app.project.slug} -> ${where} [${placed.placement.status}]`,
    project.id
  );
  const next = submitNext(placed.placement, `${FRONTEND_ORIGIN}${where}`, placed.created);
  res.status(placed.created ? 201 : 200).json({ ...toOwnerListing(placed.app, placed.placement), next });
});

const listSubmissionsSchema = z.object({ projectId: z.string().trim().min(1).optional() });

// GET .../submissions?projectId= — every place this company's apps are
// shown; optionally just one app's (its Showcase page in the console).
showcaseRouter.get("/companies/:companyId/showcase/submissions", loadCompanyContext, async (req, res) => {
  const { projectId } = listSubmissionsSchema.parse(req.query);
  const apps = await prisma.appDetails.findMany({
    where: { companyId: req.company!.id, ...(projectId && { projectId }) },
    orderBy: { createdAt: "desc" },
    include: { ...WITH_PROJECT, listings: { include: { event: true } } },
  });
  res.json(apps.flatMap((a) => placementsOf(a).map((p) => toOwnerListing(a, p))));
});

// DELETE .../submissions/:listingId — withdraw. The id is either one of this
// company's AppDetails (its public placement) or one of its event listings.
showcaseRouter.delete("/companies/:companyId/showcase/submissions/:listingId", loadCompanyContext, async (req, res) => {
  const id = req.params.listingId;
  const companyId = req.company!.id;

  const app = await prisma.appDetails.findFirst({ where: { id, companyId }, include: WITH_PROJECT });
  if (app) {
    if (!app.isPublic) return res.status(404).json({ error: "Listing not found" });
    await prisma.appDetails.update({ where: { id: app.id }, data: { isPublic: false } });
    await audit(req, "showcase.public.remove", app.project.slug, app.projectId);
    return res.status(204).end();
  }

  const listing = await prisma.showcaseEventListing.findFirst({
    where: { id, app: { companyId } },
    include: { app: { include: WITH_PROJECT }, event: { select: { slug: true } } },
  });
  if (!listing) return res.status(404).json({ error: "Listing not found" });

  await prisma.showcaseEventListing.delete({ where: { id: listing.id } });
  await audit(req, "showcase.listing.withdraw", `${listing.app.project.slug} <- /showcase/${listing.event.slug}`, listing.app.projectId);
  res.status(204).end();
});
