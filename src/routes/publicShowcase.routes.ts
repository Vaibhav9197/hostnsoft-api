import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { PUBLIC_ORDER, PUBLIC_WHERE, collectionSummary, toPublicCollection, toPublicProject } from "../services/showcase";

// Open, read-only half of Showcase — see docs/showcase.md. Every write is on
// an authenticated router. Mounted before publicDocsRouter (which serves
// GET /public/:slug) and every requireProxyToken router — see routes/index.ts.
export const publicShowcaseRouter = Router();

const listQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(60) });

// GET /public/showcase — public listings, featured first then newest.
publicShowcaseRouter.get("/public/showcase", async (req, res) => {
  const { limit } = listQuerySchema.parse(req.query);
  const projects = await prisma.showcaseProject.findMany({
    where: PUBLIC_WHERE,
    orderBy: [...PUBLIC_ORDER],
    take: limit,
    include: { collection: { select: { id: true, slug: true, title: true, type: true } } },
  });
  res.json(projects.map((p) => toPublicProject(p, p.collection)));
});

// GET /public/showcase/collections — collections with ≥1 public listing.
publicShowcaseRouter.get("/public/showcase/collections", async (_req, res) => {
  const counts = await prisma.showcaseProject.groupBy({ by: ["collectionId"], where: PUBLIC_WHERE, _count: { _all: true } });
  if (counts.length === 0) return res.json([]);
  const collections = await prisma.showcaseCollection.findMany({
    where: { id: { in: counts.map((c) => c.collectionId) } },
    orderBy: { title: "asc" },
  });
  const countById = new Map(counts.map((c) => [c.collectionId, c._count._all]));
  res.json(collections.map((c) => toPublicCollection(c, countById.get(c.id) ?? 0)));
});

// GET /public/showcase/collections/:slug — an empty page still resolves.
publicShowcaseRouter.get("/public/showcase/collections/:slug", async (req, res) => {
  const collection = await prisma.showcaseCollection.findUnique({ where: { slug: String(req.params.slug).toLowerCase() } });
  if (!collection) return res.status(404).json({ error: "Collection not found" });

  const projects = await prisma.showcaseProject.findMany({
    where: { collectionId: collection.id, isPrivate: false },
    orderBy: [...PUBLIC_ORDER],
  });
  const summary = collectionSummary(collection);
  res.json({
    collection: toPublicCollection(collection, projects.length),
    projects: projects.map((p) => toPublicProject(p, summary)),
  });
});

// GET /public/showcase/apps/:slug — a hidden listing 404s like an unknown one.
publicShowcaseRouter.get("/public/showcase/apps/:slug", async (req, res) => {
  const project = await prisma.showcaseProject.findFirst({
    where: { slug: String(req.params.slug), ...PUBLIC_WHERE },
    include: { collection: { select: { id: true, slug: true, title: true, type: true } } },
  });
  if (!project) return res.status(404).json({ error: "Project not found" });
  res.json(toPublicProject(project, project.collection));
});
