import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getCompanyById } from "../lib/msg91";
import { requireProxyToken } from "../middleware/proxyToken";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin";
import { collectionCounts, showcaseTypeSchema, toOwnerCollection, toOwnerProject } from "../services/showcase";

// Oversight half of Showcase — see docs/showcase.md. Nothing is approved
// here: pages and listings go live on creation. The admin sees every page
// and every listing, and features listings. Super-admin only (404s for
// non-admins, same as admin.routes.ts). Split out only for file size.
export const adminShowcaseRouter = Router();
adminShowcaseRouter.use(requireProxyToken);
adminShowcaseRouter.use(requireSuperAdmin);

// Company names via proxy (TTL-cached), batched per unique id.
async function companyNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const companies = await Promise.all(unique.map((id) => getCompanyById(id)));
  return new Map(unique.map((id, i) => [id, companies[i]?.name ?? "Unknown company"]));
}

const listCollectionsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  type: showcaseTypeSchema.optional(),
  q: z.string().min(1).optional(),
});

// GET /admin/showcase/collections — every page, newest first.
adminShowcaseRouter.get("/admin/showcase/collections", async (req, res) => {
  const query = listCollectionsSchema.parse(req.query);
  const where: Prisma.ShowcaseCollectionWhereInput = {
    ...(query.type && { type: query.type }),
    ...(query.q && { OR: [{ slug: { contains: query.q } }, { title: { contains: query.q } }] }),
  };

  const [total, items] = await Promise.all([
    prisma.showcaseCollection.count({ where }),
    prisma.showcaseCollection.findMany({ where, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.limit, take: query.limit }),
  ]);

  const [names, counts] = await Promise.all([companyNames(items.map((c) => c.companyId)), collectionCounts(items.map((c) => c.id))]);

  res.json({
    items: items.map((c) => ({ ...toOwnerCollection(c, counts.get(c.id)!), companyName: names.get(c.companyId) })),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.ceil(total / query.limit),
  });
});

const listProjectsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  collectionId: z.string().min(1).optional(),
  q: z.string().min(1).optional(),
});

// GET /admin/showcase/projects — every listing across every slug, for oversight and featuring.
adminShowcaseRouter.get("/admin/showcase/projects", async (req, res) => {
  const query = listProjectsSchema.parse(req.query);
  const where: Prisma.ShowcaseProjectWhereInput = {
    ...(query.collectionId && { collectionId: query.collectionId }),
    ...(query.q && { OR: [{ name: { contains: query.q } }, { creatorName: { contains: query.q } }, { appUrl: { contains: query.q } }] }),
  };

  const [total, items] = await Promise.all([
    prisma.showcaseProject.count({ where }),
    prisma.showcaseProject.findMany({
      where,
      orderBy: [{ featured: "desc" }, { createdAt: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: { collection: { select: { id: true, slug: true, title: true, type: true, companyId: true } } },
    }),
  ]);

  const names = await companyNames([...items.map((p) => p.companyId), ...items.map((p) => p.collection.companyId)]);

  res.json({
    items: items.map((p) => ({
      ...toOwnerProject(p, p.collection),
      submitterCompany: { id: p.companyId, name: names.get(p.companyId) },
      ownerCompany: { id: p.collection.companyId, name: names.get(p.collection.companyId) },
    })),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.ceil(total / query.limit),
  });
});

const patchProjectSchema = z.object({ featured: z.boolean() });

// PATCH /admin/showcase/projects/:id {featured} — the admin's one lever on a listing.
adminShowcaseRouter.patch("/admin/showcase/projects/:id", async (req, res) => {
  const { featured } = patchProjectSchema.parse(req.body);
  const existing = await prisma.showcaseProject.findUnique({
    where: { id: req.params.id },
    include: { collection: { select: { id: true, slug: true, title: true, type: true } } },
  });
  if (!existing) return res.status(404).json({ error: "Listing not found" });

  const updated = await prisma.showcaseProject.update({ where: { id: existing.id }, data: { featured } });
  res.json(toOwnerProject(updated, existing.collection));
});
