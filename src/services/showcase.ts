import { z } from "zod";
import type { Project, ShowcaseCollection, ShowcaseProject } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { isUniqueConstraintViolation } from "../lib/prismaErrors";
import { TtlCache } from "../lib/ttlCache";
import { logger } from "../lib/logger";

// Shared by the public/company/admin showcase routers — see docs/showcase.md.

// ---- type & options

// company: reserved for the company at creation, only its own apps. public:
// a public board,
// created from the console, open to every company's apps.
export const SHOWCASE_TYPES = ["company", "public"] as const;
export type ShowcaseType = (typeof SHOWCASE_TYPES)[number];
export const showcaseTypeSchema = z.enum(SHOWCASE_TYPES);

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

// ---- collection slug

// Reserved: routes that would collide under /showcase/<slug> on the frontend.
const RESERVED_SLUGS = new Set(["apps", "submit", "collections", "admin", "api", "new", "edit", "embarko", "hostnsoft"]);

export const collectionSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Slug must be at least 3 characters")
  .max(40, "Slug must be at most 40 characters")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, digits and single dashes only")
  .refine((s) => !RESERVED_SLUGS.has(s), "That slug is reserved");

// ---- company page

const SLUG_MAX = 40;

function slugifyCollection(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-$/, "");
}

// A slug for a company page, derived from the company name, suffixed until
// free. Falls back to the company id when the name yields nothing usable.
export async function uniqueCompanySlug(name: string, companyId: string): Promise<string> {
  let base = slugifyCollection(name);
  if (!collectionSlugSchema.safeParse(base).success) base = slugifyCollection(`company-${companyId}`);
  if (!collectionSlugSchema.safeParse(base).success) base = `company-${Date.now()}`;

  const taken = new Set(
    (
      await prisma.showcaseCollection.findMany({
        where: { OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }] },
        select: { slug: true },
      })
    ).map((r) => r.slug)
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base.slice(0, SLUG_MAX - String(n).length - 1)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, SLUG_MAX - 14)}-${Date.now()}`;
}

// Every company gets its page the moment we learn of the company: from
// POST /companies, and (for proxy-made companies that never pass there) at
// login. Idempotent; the unique slug race is absorbed by retrying once.
export async function ensureCompanyCollection(
  company: { id: string; name: string },
  createdBy: string
): Promise<ShowcaseCollection> {
  const existing = await prisma.showcaseCollection.findFirst({ where: { companyId: company.id, type: "company" } });
  if (existing) return existing;

  for (let attempt = 0; ; attempt++) {
    const slug = await uniqueCompanySlug(company.name, company.id);
    try {
      return await prisma.showcaseCollection.create({
        data: { slug, title: company.name, intro: null, type: "company", companyId: company.id, createdBy },
      });
    } catch (err) {
      if (!isUniqueConstraintViolation(err) || attempt >= 2) throw err;
      const raced = await prisma.showcaseCollection.findFirst({ where: { companyId: company.id, type: "company" } });
      if (raced) return raced;
    }
  }
}

// Cached "already has a page" answer so the middleware costs a Redis hit,
// not a DB query, per request. Short TTL, because Redis can outlive the DB
// row (a dev reset, a restore): a stale "ready" only ever delays the page
// by minutes, and a miss just re-checks the DB.
const companyPageReady = new TtlCache<boolean>("showcasePageReady", 10 * 60 * 1000);

// Cheap pre-check for the middleware: true once a page is known to exist.
export async function hasCompanyPage(companyId: string): Promise<boolean> {
  return (await companyPageReady.get(companyId)) === true;
}

// Never-throwing form for hot paths: loadCompanyContext (every company-scoped
// request) and POST /companies. Existing companies, which predate showcase,
// pick up their page on the first scoped request made for them.
export async function ensureCompanyPage(company: { id: string; name: string }, createdBy: string): Promise<void> {
  try {
    if (await companyPageReady.get(company.id)) return;
    await ensureCompanyCollection(company, createdBy);
    await companyPageReady.getOrLoad(company.id, async () => true);
  } catch (err) {
    logger.warn(`[showcase] company page reservation failed for ${company.id}: ${String(err)}`);
  }
}

// Who may list an app on a collection: anyone on a public board, only the
// owner on a company page.
export function canListOn(collection: Pick<ShowcaseCollection, "type" | "companyId">, companyId: string): boolean {
  return collection.type === "public" || collection.companyId === companyId;
}

// ---- app URL

// Not its own config file for one constant — see env.ts for the same pattern.
const APP_PUBLIC_DOMAIN = (process.env.APP_PUBLIC_DOMAIN ?? "embarko.app").replace(/^https?:\/\//, "");

// The hostname an app is served under when it has no custom domain.
// Exported so services/projectSlugChange.ts can recognise (and rewrite)
// exactly those listing snapshots that point at a slug that just changed,
// without having to rebuild this string — and get it subtly wrong — there.
//
// Every app is on APP_PUBLIC_DOMAIN. The app.embarko.ai -> embarko.app
// move is complete, so the per-project fork on createdAt that used to
// pick between the two suffixes is gone.
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

export const showcaseSubmissionSchema = z.object({
  collectionSlug: collectionSlugSchema,
  projectId: z.string().trim().min(1),
  name: z.string().trim().min(1, "App name is required").max(80),
  tagline: z.string().trim().min(1, "Tell us what it does").max(160),
  whatItDoes: optionalText(4000),
  whyBuilt: optionalText(600),
  creatorName: z.string().trim().min(1, "Creator name is required").max(80),
  creatorProfile: optionalUrl,
  builtWith: optionalOneOf(SHOWCASE_TOOLS),
  category: optionalOneOf(SHOWCASE_CATEGORIES),
  tags: z.array(z.string()).max(20).optional().default([]),
  videoUrl: optionalUrl,
  screenshotUrl: optionalUrl,
});
export type ShowcaseSubmissionInput = z.infer<typeof showcaseSubmissionSchema>;

// Same fields as showcaseSubmissionSchema minus projectId: the agent path
// addresses its app via the deploy token + :appName (req.project), not an id
// it would have to already know.
export const agentShowcaseSubmissionSchema = showcaseSubmissionSchema.omit({ projectId: true });
export type AgentShowcaseSubmissionInput = z.infer<typeof agentShowcaseSubmissionSchema>;

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

function slugifyName(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60) || "app"
  );
}

// Two identical names is ordinary; the second gets a suffix.
export async function uniqueProjectSlug(name: string): Promise<string> {
  const base = slugifyName(name);
  const taken = new Set(
    (
      await prisma.showcaseProject.findMany({
        where: { OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }] },
        select: { slug: true },
      })
    ).map((r) => r.slug)
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

// ---- visibility

export const PUBLIC_WHERE = { isPrivate: false } as const;
export const PUBLIC_ORDER = [{ featured: "desc" }, { createdAt: "desc" }] as const;

// ---- serialization

export function parseTags(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export type CollectionSummary = { id: string; slug: string; title: string; type: string };

export function collectionSummary(c: Pick<ShowcaseCollection, "id" | "slug" | "title" | "type">): CollectionSummary {
  return { id: c.id, slug: c.slug, title: c.title, type: c.type };
}

// Public shape: no owner, no submitter.
export function toPublicProject(p: ShowcaseProject, collection: CollectionSummary) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    tagline: p.tagline,
    whatItDoes: p.whatItDoes,
    whyBuilt: p.whyBuilt,
    appUrl: p.appUrl,
    screenshotUrl: p.screenshotUrl,
    videoUrl: p.videoUrl,
    creatorName: p.creatorName,
    creatorProfile: p.creatorProfile,
    builtWith: p.builtWith,
    category: p.category,
    tags: parseTags(p.tagsJson),
    featured: p.featured,
    createdAt: p.createdAt.toISOString(),
    collection: { slug: collection.slug, title: collection.title, type: collection.type as ShowcaseType },
  };
}

// Owner/admin shape: public shape plus provenance and visibility.
export function toOwnerProject(p: ShowcaseProject, collection: CollectionSummary) {
  return {
    ...toPublicProject(p, collection),
    collectionId: p.collectionId,
    projectId: p.projectId,
    companyId: p.companyId,
    submittedBy: p.submittedBy,
    isPrivate: p.isPrivate,
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function toPublicCollection(c: ShowcaseCollection, projectCount: number) {
  return {
    slug: c.slug,
    title: c.title,
    intro: c.intro,
    type: c.type as ShowcaseType,
    projectCount,
    createdAt: c.createdAt.toISOString(),
  };
}

export type CollectionCounts = { total: number; publicCount: number };

// Owner/admin shape — adds ownership. Never public.
export function toOwnerCollection(c: ShowcaseCollection, counts: CollectionCounts) {
  return {
    id: c.id,
    slug: c.slug,
    title: c.title,
    intro: c.intro,
    type: c.type as ShowcaseType,
    companyId: c.companyId,
    createdBy: c.createdBy,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    counts,
  };
}

// One grouped query for a batch of collections, for list and detail views.
export async function collectionCounts(collectionIds: string[]): Promise<Map<string, CollectionCounts>> {
  const map = new Map<string, CollectionCounts>();
  for (const id of collectionIds) map.set(id, { total: 0, publicCount: 0 });
  if (collectionIds.length === 0) return map;

  const rows = await prisma.showcaseProject.groupBy({
    by: ["collectionId", "isPrivate"],
    where: { collectionId: { in: collectionIds } },
    _count: { _all: true },
  });
  for (const r of rows) {
    const c = map.get(r.collectionId)!;
    c.total += r._count._all;
    if (!r.isPrivate) c.publicCount += r._count._all;
  }
  return map;
}
