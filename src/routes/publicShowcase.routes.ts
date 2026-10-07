import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { GALLERY_ORDER, PUBLIC_PAGE, WITH_PROJECT, eventSummary, resolveContributors, toPublicApp, toPublicEvent } from "../services/showcase";

// Open, read-only half of Showcase — see docs/showcase.md. Every write is on
// an authenticated router. Mounted before publicDocsRouter (which serves
// GET /public/:slug) and every requireProxyToken router — see routes/index.ts.
export const publicShowcaseRouter = Router();

const listQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(60) });

// GET /public/showcase — the home gallery: public apps, featured first then newest.
publicShowcaseRouter.get("/public/showcase", async (req, res) => {
  const { limit } = listQuerySchema.parse(req.query);
  const apps = await prisma.appDetails.findMany({ where: { isPublic: true }, orderBy: [...GALLERY_ORDER], take: limit, include: WITH_PROJECT });
  res.json(apps.map((a) => toPublicApp(a, PUBLIC_PAGE)));
});

// GET /public/showcase/collections — every event page with its public app
// count, fullest first. Feeds the "more showcase pages" row on the frontend.
publicShowcaseRouter.get("/public/showcase/collections", async (_req, res) => {
  const events = await prisma.showcaseEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { _count: { select: { listings: { where: { status: "approved", isHidden: false } } } } },
  });
  res.json(events.map((e) => toPublicEvent(e, e._count.listings)).sort((a, b) => b.projectCount - a.projectCount));
});

// GET /public/showcase/collections/:slug — an empty event page still resolves.
// The one public read that carries the event's customHtml.
publicShowcaseRouter.get("/public/showcase/collections/:slug", async (req, res) => {
  const event = await prisma.showcaseEvent.findUnique({ where: { slug: String(req.params.slug).toLowerCase() } });
  if (!event) return res.status(404).json({ error: "Collection not found" });

  const listings = await prisma.showcaseEventListing.findMany({
    where: { eventId: event.id, status: "approved", isHidden: false },
    include: { app: { include: WITH_PROJECT } },
  });
  const apps = listings
    .map((l) => l.app)
    .sort((a, b) => Number(b.featured) - Number(a.featured) || b.createdAt.getTime() - a.createdAt.getTime());
  const page = eventSummary(event);
  res.json({ collection: toPublicEvent(event, apps.length, { html: true }), projects: apps.map((a) => toPublicApp(a, page)) });
});

// GET /public/showcase/apps/:slug — an app shown nowhere 404s like an unknown one.
// The only read that adds `contributors` (resolved against proxy per request).
publicShowcaseRouter.get("/public/showcase/apps/:slug", async (req, res) => {
  const app = await prisma.appDetails.findFirst({
    where: { project: { slug: String(req.params.slug).toLowerCase() } },
    include: { ...WITH_PROJECT, listings: { where: { status: "approved", isHidden: false }, orderBy: { createdAt: "asc" }, include: { event: true } } },
  });
  if (!app || (!app.isPublic && app.listings.length === 0)) return res.status(404).json({ error: "Project not found" });
  const page = app.isPublic ? PUBLIC_PAGE : eventSummary(app.listings[0].event);
  res.json({ ...toPublicApp(app, page), contributors: await resolveContributors(app) });
});
