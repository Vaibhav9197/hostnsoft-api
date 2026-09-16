import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { isUniqueConstraintViolation } from "../lib/prismaErrors";
import { requireProxyToken } from "../middleware/proxyToken";
import { loadCompanyContext } from "../middleware/companyContext";
import { logAudit } from "../services/audit";
import {
  canListOn,
  collectionCounts,
  collectionSlugSchema,
  collectionSummary,
  normalizeTags,
  resolveAppUrl,
  showcaseSubmissionSchema,
  toOwnerCollection,
  toOwnerProject,
  toPublicCollection,
  uniqueProjectSlug,
} from "../services/showcase";

// Company half of Showcase — see docs/showcase.md. A logged-in member of
// :companyId acts as ORGANISER of the pages it owns (its reserved company
// page plus any public boards it created) and as SUBMITTER of this company's
// apps onto any public board. Every lookup scoped by companyId.
export const showcaseRouter = Router();
showcaseRouter.use(requireProxyToken);

async function findCollection(companyId: string, collectionId: string) {
  return prisma.showcaseCollection.findFirst({ where: { id: collectionId, companyId } });
}

async function ownedCollectionOr404(req: Request, res: Response) {
  const collection = await findCollection(req.company!.id, req.params.collectionId);
  if (!collection) res.status(404).json({ error: "Collection not found" });
  return collection;
}

function audit(req: Request, action: string, details: string, projectId?: string) {
  return logAudit({ actorUserId: req.userId, companyId: req.company!.id, projectId, action, details });
}

// =========================================================== organiser side

const createCollectionSchema = z.object({
  slug: collectionSlugSchema,
  title: z.string().trim().min(1).max(80),
  intro: z.string().trim().max(600).optional().nullable(),
});

// POST .../collections — create a public board. Live at once, open to every
// company's apps. The company page is never created here; it's reserved at
// company creation (ensureCompanyCollection).
showcaseRouter.post("/companies/:companyId/showcase/collections", loadCompanyContext, async (req, res) => {
  const body = createCollectionSchema.parse(req.body);

  try {
    const collection = await prisma.showcaseCollection.create({
      data: { ...body, intro: body.intro ?? null, type: "public", companyId: req.company!.id, createdBy: req.userId! },
    });
    await audit(req, "showcase.collection.create", collection.slug);
    res.status(201).json(toOwnerCollection(collection, { total: 0, publicCount: 0 }));
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      return res.status(409).json({ error: "That slug is already taken", code: "SHOWCASE_SLUG_TAKEN" });
    }
    throw err;
  }
});

// GET .../collections — every page this company owns: its company page first, then public boards.
showcaseRouter.get("/companies/:companyId/showcase/collections", loadCompanyContext, async (req, res) => {
  const collections = await prisma.showcaseCollection.findMany({
    where: { companyId: req.company!.id },
    orderBy: [{ type: "asc" }, { createdAt: "desc" }],
  });
  const counts = await collectionCounts(collections.map((c) => c.id));
  res.json(collections.map((c) => toOwnerCollection(c, counts.get(c.id)!)));
});

// GET .../collections/:collectionId — plus everything listed under it, hidden or not.
showcaseRouter.get("/companies/:companyId/showcase/collections/:collectionId", loadCompanyContext, async (req, res) => {
  const collection = await ownedCollectionOr404(req, res);
  if (!collection) return;

  const [projects, counts] = await Promise.all([
    prisma.showcaseProject.findMany({ where: { collectionId: collection.id }, orderBy: { createdAt: "desc" } }),
    collectionCounts([collection.id]),
  ]);
  const summary = collectionSummary(collection);
  res.json({
    ...toOwnerCollection(collection, counts.get(collection.id)!),
    projects: projects.map((p) => toOwnerProject(p, summary)),
  });
});

// DELETE .../collections/:collectionId — public boards only, and only while empty.
// The company page is the company's reserved address and can't be dropped.
showcaseRouter.delete("/companies/:companyId/showcase/collections/:collectionId", loadCompanyContext, async (req, res) => {
  const collection = await ownedCollectionOr404(req, res);
  if (!collection) return;
  if (collection.type === "company") {
    return res.status(409).json({ error: "A company's own showcase page can't be deleted", code: "SHOWCASE_COMPANY_PAGE" });
  }

  const listed = await prisma.showcaseProject.count({ where: { collectionId: collection.id } });
  if (listed > 0) {
    return res.status(409).json({ error: "Apps are listed under this page; it can't be deleted", code: "SHOWCASE_COLLECTION_NOT_EMPTY" });
  }
  await prisma.showcaseCollection.delete({ where: { id: collection.id } });
  await audit(req, "showcase.collection.delete", collection.slug);
  res.status(204).end();
});

// Either flip visibility or remove outright — one route for the organiser's
// two levers on a listing, so the console needs no second endpoint.
const updateListingSchema = z.union([
  z.object({ isPrivate: z.boolean() }),
  z.object({ remove: z.literal(true) }),
]);

// PATCH .../collections/:collectionId/projects/:projectId
//   {isPrivate}    — organiser hides/unhides a listing (200, the listing)
//   {remove:true}  — organiser takes it off the page for good (204). The
//                    app's owner can list it again; nothing stops them.
showcaseRouter.patch(
  "/companies/:companyId/showcase/collections/:collectionId/projects/:projectId",
  loadCompanyContext,
  async (req, res) => {
    const body = updateListingSchema.parse(req.body);
    const collection = await ownedCollectionOr404(req, res);
    if (!collection) return;
    const existing = await prisma.showcaseProject.findFirst({ where: { id: req.params.projectId, collectionId: collection.id } });
    if (!existing) return res.status(404).json({ error: "Listing not found" });

    if ("remove" in body) {
      await prisma.showcaseProject.delete({ where: { id: existing.id } });
      await audit(req, "showcase.listing.remove", `${existing.slug} <- /showcase/${collection.slug}`, existing.projectId);
      return res.status(204).end();
    }

    const updated = await prisma.showcaseProject.update({ where: { id: existing.id }, data: { isPrivate: body.isPrivate } });
    await audit(req, body.isPrivate ? "showcase.listing.hide" : "showcase.listing.show", updated.slug);
    res.json(toOwnerProject(updated, collectionSummary(collection)));
  }
);

// =========================================================== submitter side

// GET .../pages — every page this company may list an app on: its own
// company page plus every public board, newest first. Feeds the submit form's
// page picker (the public collections list only shows non-empty pages).
showcaseRouter.get("/companies/:companyId/showcase/pages", loadCompanyContext, async (req, res) => {
  const collections = await prisma.showcaseCollection.findMany({
    where: { OR: [{ type: "public" }, { type: "company", companyId: req.company!.id }] },
    orderBy: [{ type: "asc" }, { createdAt: "desc" }],
  });
  const counts = await collectionCounts(collections.map((c) => c.id));
  res.json(collections.map((c) => toPublicCollection(c, counts.get(c.id)!.publicCount)));
});

const COLLECTION_UNKNOWN = { error: "That showcase page doesn't exist", code: "SHOWCASE_COLLECTION_UNKNOWN" } as const;

// POST .../submissions — list one of this company's own apps under the
// named page. Live at once. Public boards take anyone's apps; a company page
// takes only its owner's.
showcaseRouter.post("/companies/:companyId/showcase/submissions", loadCompanyContext, async (req, res) => {
  const body = showcaseSubmissionSchema.parse(req.body);

  const collection = await prisma.showcaseCollection.findUnique({ where: { slug: body.collectionSlug } });
  if (!collection) return res.status(404).json(COLLECTION_UNKNOWN);
  if (!canListOn(collection, req.company!.id)) {
    return res.status(403).json({
      error: `/showcase/${collection.slug} is a company's own page; only its apps can be listed there`,
      code: "SHOWCASE_COLLECTION_PRIVATE",
    });
  }

  const project = await prisma.project.findFirst({ where: { id: body.projectId, companyId: req.company!.id } });
  if (!project) return res.status(404).json({ error: "Project not found" });

  const already = await prisma.showcaseProject.findUnique({
    where: { collectionId_projectId: { collectionId: collection.id, projectId: project.id } },
  });
  if (already) {
    return res.status(409).json({
      error: `${project.name} is already listed under /showcase/${collection.slug}`,
      code: "SHOWCASE_ALREADY_LISTED",
      listing: { id: already.id, slug: already.slug },
    });
  }

  const data = {
    collectionId: collection.id,
    projectId: project.id,
    companyId: req.company!.id,
    submittedBy: req.userId!,
    name: body.name,
    tagline: body.tagline,
    appUrl: await resolveAppUrl(project),
    whatItDoes: body.whatItDoes ?? null,
    whyBuilt: body.whyBuilt ?? null,
    creatorName: body.creatorName,
    creatorProfile: body.creatorProfile ?? null,
    builtWith: body.builtWith ?? null,
    category: body.category ?? null,
    tagsJson: JSON.stringify(normalizeTags(body.tags)),
    videoUrl: body.videoUrl ?? null,
    screenshotUrl: body.screenshotUrl ?? null,
  };

  // A name collision retries once with a fresh slug; a (collectionId, projectId) collision doesn't.
  let listing = null;
  for (let attempt = 0; attempt < 2 && !listing; attempt++) {
    const slug = await uniqueProjectSlug(body.name);
    try {
      listing = await prisma.showcaseProject.create({ data: { ...data, slug } });
    } catch (err) {
      if (!isUniqueConstraintViolation(err)) throw err;
      if (attempt === 1) {
        return res.status(409).json({ error: "That app is already listed there", code: "SHOWCASE_ALREADY_LISTED" });
      }
    }
  }

  await audit(req, "showcase.listing.create", `${listing!.slug} -> /showcase/${collection.slug}`, project.id);
  res.status(201).json(toOwnerProject(listing!, collectionSummary(collection)));
});

const listSubmissionsSchema = z.object({ projectId: z.string().trim().min(1).optional() });

// GET .../submissions?projectId= — every listing this company has made, any
// page; optionally just one app's (the app's settings page).
showcaseRouter.get("/companies/:companyId/showcase/submissions", loadCompanyContext, async (req, res) => {
  const { projectId } = listSubmissionsSchema.parse(req.query);
  const listings = await prisma.showcaseProject.findMany({
    where: { companyId: req.company!.id, ...(projectId && { projectId }) },
    orderBy: { createdAt: "desc" },
    include: { collection: { select: { id: true, slug: true, title: true, type: true } } },
  });
  res.json(listings.map((p) => toOwnerProject(p, p.collection)));
});

// DELETE .../submissions/:listingId — withdraw one of this company's own listings.
showcaseRouter.delete("/companies/:companyId/showcase/submissions/:listingId", loadCompanyContext, async (req, res) => {
  const existing = await prisma.showcaseProject.findFirst({
    where: { id: req.params.listingId, companyId: req.company!.id },
    include: { collection: { select: { slug: true } } },
  });
  if (!existing) return res.status(404).json({ error: "Listing not found" });

  await prisma.showcaseProject.delete({ where: { id: existing.id } });
  await audit(req, "showcase.listing.withdraw", `${existing.slug} <- /showcase/${existing.collection.slug}`, existing.projectId);
  res.status(204).end();
});
