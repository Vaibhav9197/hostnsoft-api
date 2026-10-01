import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getCompanyById } from "../lib/msg91";
import { requireProxyToken } from "../middleware/proxyToken";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin";
import {
  GALLERY_ORDER,
  PUBLIC_PAGE_ID,
  eventCounts,
  eventPlacement,
  publicPlacement,
  toOwnerEvent,
  WITH_PROJECT,
  toOwnerListing,
} from "../services/showcase";

// Oversight half of Showcase — see docs/showcase.md. Nothing is approved
// here: pages and listings go live on creation. The admin sees every event
// and every app, and features apps. Super-admin only (404s for non-admins,
// same as admin.routes.ts). Split out only for file size.
export const adminShowcaseRouter = Router();
adminShowcaseRouter.use(requireProxyToken);
adminShowcaseRouter.use(requireSuperAdmin);

// Company names via proxy (TTL-cached), batched per unique id.
async function companyNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const companies = await Promise.all(unique.map((id) => getCompanyById(id)));
  return new Map(unique.map((id, i) => [id, companies[i]?.name ?? "Unknown company"]));
}

const pageSchema = {
  page: z.coerce.number().int().min(1).default(1),
  q: z.string().min(1).optional(),
};

const listEventsSchema = z.object({
  ...pageSchema,
  limit: z.coerce.number().int().min(1).max(100).default(25),
  // Accepted and ignored: every page here is an event now.
  type: z.string().optional(),
});

// GET /admin/showcase/collections — every event, newest first.
adminShowcaseRouter.get("/admin/showcase/collections", async (req, res) => {
  const query = listEventsSchema.parse(req.query);
  const where: Prisma.ShowcaseEventWhereInput = {
    ...(query.q && { OR: [{ slug: { contains: query.q } }, { title: { contains: query.q } }] }),
  };

  const [total, items] = await Promise.all([
    prisma.showcaseEvent.count({ where }),
    prisma.showcaseEvent.findMany({ where, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.limit, take: query.limit }),
  ]);
  const [names, counts] = await Promise.all([companyNames(items.map((e) => e.companyId)), eventCounts(items.map((e) => e.id))]);

  res.json({
    items: items.map((e) => ({ ...toOwnerEvent(e, counts.get(e.id)!), companyName: names.get(e.companyId) })),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.ceil(total / query.limit),
  });
});

const listAppsSchema = z.object({
  ...pageSchema,
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // "public" narrows to the gallery; an event id to that event's apps.
  collectionId: z.string().min(1).optional(),
});

// GET /admin/showcase/projects — every app with details, one row each, for
// oversight and featuring. Shown against its public placement when it has
// one, else its first event.
adminShowcaseRouter.get("/admin/showcase/projects", async (req, res) => {
  const query = listAppsSchema.parse(req.query);
  const where: Prisma.AppDetailsWhereInput = {
    ...(query.collectionId === PUBLIC_PAGE_ID && { isPublic: true }),
    ...(query.collectionId && query.collectionId !== PUBLIC_PAGE_ID && { listings: { some: { eventId: query.collectionId } } }),
    ...(query.q && { OR: [{ name: { contains: query.q } }, { creatorName: { contains: query.q } }, { appUrl: { contains: query.q } }] }),
  };

  const [total, items] = await Promise.all([
    prisma.appDetails.count({ where }),
    prisma.appDetails.findMany({
      where,
      orderBy: [...GALLERY_ORDER],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: { ...WITH_PROJECT, listings: { orderBy: { createdAt: "asc" }, include: { event: true } } },
    }),
  ]);
  const names = await companyNames(items.map((a) => a.companyId));

  res.json({
    items: items.map((a) => {
      const placement = a.isPublic || a.listings.length === 0 ? publicPlacement(a) : eventPlacement(a.listings[0], a.listings[0].event);
      const company = { id: a.companyId, name: names.get(a.companyId) };
      return { ...toOwnerListing(a, placement), submitterCompany: company, ownerCompany: company };
    }),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.ceil(total / query.limit),
  });
});

const patchAppSchema = z.object({ featured: z.boolean() });

// PATCH /admin/showcase/projects/:id {featured} — the admin's one lever on an app.
adminShowcaseRouter.patch("/admin/showcase/projects/:id", async (req, res) => {
  const { featured } = patchAppSchema.parse(req.body);
  const existing = await prisma.appDetails.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Listing not found" });

  const updated = await prisma.appDetails.update({ where: { id: existing.id }, data: { featured }, include: WITH_PROJECT });
  res.json(toOwnerListing(updated, publicPlacement(updated)));
});
