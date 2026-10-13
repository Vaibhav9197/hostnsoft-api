import { Router } from "express";
import { z } from "zod";
import type { Project } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { createDeploymentWithNextVersion, markProjectDeploymentLive } from "../services/deploymentVersioning";
import { unauthorizedDeployTokenBody } from "../services/deployTokenAuth";
import { claimProjectForCompany } from "../services/projectClaim";
import { deployCredentialFields, resolveDeployActor } from "../services/deployActor";
import { logAudit } from "../services/audit";
import { requireInternalSecret } from "../middleware/requireInternalSecret";
import { agentNameSchema } from "../lib/deployAttribution";

export const internalDeploymentsRouter = Router();

const recordSchema = z.object({
  // Same credential shapes as POST /internal/projects/claim — a deploy
  // token, or a proxy_auth_token + companyId for a dashboard upload, or
  // (since 2026-10-08) neither, for an anonymous deploy. See
  // services/deployActor.ts. An anonymous call is accepted only while the
  // project is still an unclaimed orphan — the row it writes is what lets
  // the claim link keep the app with no rebuild (see projects.routes.ts's
  // POST /companies/:companyId/orphans/claim): applyCurrentConfig needs
  // the running image's tag, and only this endpoint knows it.
  ...deployCredentialFields,
  projectSlug: z.string().min(1),
  // Whatever hostnsoft-deploy used for the image tag (X-App-Version, or
  // its own timestamp fallback) — NOT the deployment's identity. A user
  // can redeploy without bumping this at all; see schema.prisma.
  appVersion: z.string().min(1),
  // "in_progress" — the build/deploy now runs in the background after
  // the upload response is already sent (avoiding a proxy timeout on a
  // slow build), so a deployment attempt is recorded the moment it
  // STARTS, not only once it concludes, and the same row is later
  // updated in place (see deploymentId below) rather than a second row
  // being created.
  status: z.enum(["in_progress", "success", "failed"]),
  imageTag: z.string().optional(),
  memoryMb: z.number().int().optional(),
  errorDetail: z.string().optional(),
  // "static" (files served directly, no server process) or "service"
  // (built and run as a job) — what hostnsoft-deploy actually deployed,
  // per railpack's own inspection (its build-plan.js). Persisted onto
  // Project.kind on success only: a static upload can still fail
  // before it's live (and be undone on hostnsoft-deploy's side), and an
  // in_progress row says nothing about what will end up serving. Optional
  // so an older hostnsoft-deploy that doesn't send it keeps working; the
  // column is then simply left as it was. Extend this enum (and
  // hostnsoft-deploy's finishDeploySuccess callers) when a new kind
  // of app is introduced.
  kind: z.enum(["static", "service"]).optional(),
  // If set, updates this existing row (must belong to the resolved
  // project) instead of allocating a new version — the second call for a
  // given deploy attempt (transitioning in_progress -> success/failed),
  // as opposed to the first call that created it.
  deploymentId: z.string().min(1).optional(),
  // The deploy's X-Agent-Name, already validated by hostnsoft-deploy.
  // Only read on the row-creating call, and ignored for a dashboard
  // deploy — see schema.prisma's Deployment.agentName.
  agentName: agentNameSchema.optional(),
});

// Called by hostnsoft-deploy (server-to-server) once a deploy attempt has
// concluded, success or failure — this is what actually populates the
// deployment history GET /companies/:companyId/projects/:projectId/deployments
// reads. Same auth shape as /internal/deploy-tokens/validate: no
// requireProxyToken, the credential in the body (re-checked here,
// independently of whatever check happened earlier in the same deploy
// request) is what authenticates the call, so this endpoint is
// trustworthy on its own rather than relying on the caller having
// already been authenticated once. That credential — a deploy token, or
// a proxy_auth_token + companyId for a dashboard upload (added
// 2026-09-17, see services/deployActor.ts) — is also the source of truth
// for which company this deployment belongs to; the request never gets
// to name a company it hasn't proven it can act for.
//
// Project resolution here is a defense-in-depth backstop, not the
// primary enforcement point — hostnsoft-deploy is expected to have
// already called POST /internal/projects/claim before ever building, so
// the "wrong company" conflict below should be close to unreachable in
// practice. Shares claimProjectForCompany with that endpoint rather than
// duplicating the create-then-catch-conflict logic.
internalDeploymentsRouter.post("/internal/deployments/record", async (req, res) => {
  const body = recordSchema.parse(req.body);

  const resolved = await resolveDeployActor(req, body);
  if (!resolved.ok) {
    return res.status(resolved.status).json(resolved.body);
  }
  const actor = resolved.actor;

  let project: Project;
  if (actor.companyId) {
    const claim = await claimProjectForCompany(actor.companyId, body.projectSlug, actor.userId);
    if (claim.rejected) {
      return res.status(409).json({ error: claim.rejected.reason, code: claim.rejected.code });
    }
    if (claim.conflict) {
      return res.status(409).json({
        error: `Project slug "${body.projectSlug}" belongs to a different company`,
        code: "app_name_taken",
      });
    }
    project = claim.project;
  } else {
    // No credential at all: an anonymous deploy. Unlike the claim
    // endpoint this never creates a project — hostnsoft-deploy has already
    // claimed (or reused) the orphan before building, so the row must
    // exist and must still be an orphan. A claimed app gets the same 401 a
    // dead deploy token does: from hostnsoft-deploy's side both mean
    // "this deploy can't be recorded, don't retry as-is", and an anonymous
    // caller must never be able to append history to someone's claimed
    // app by name alone.
    const orphan = await prisma.project.findUnique({ where: { slug: body.projectSlug } });
    if (!orphan || !orphan.isOrphan) {
      return res.status(401).json(unauthorizedDeployTokenBody());
    }
    project = orphan;
  }

  // finishedAt stays null while in_progress — set the moment the
  // attempt actually concludes, on whichever call (create or update)
  // that turns out to be.
  const finishedAt = body.status === "in_progress" ? null : new Date();

  let deployment;
  if (body.deploymentId) {
    const existing = await prisma.deployment.findFirst({
      where: { id: body.deploymentId, projectId: project.id },
    });
    if (!existing) {
      return res.status(404).json({ error: "Deployment not found" });
    }
    deployment = await prisma.deployment.update({
      where: { id: existing.id },
      data: {
        status: body.status,
        imageTag: body.imageTag,
        memoryMb: body.memoryMb,
        errorDetail: body.errorDetail,
        finishedAt,
      },
    });
  } else {
    deployment = await createDeploymentWithNextVersion(project.id, {
      appVersion: body.appVersion,
      imageTag: body.imageTag,
      memoryMb: body.memoryMb,
      status: body.status,
      errorDetail: body.errorDetail,
      // "anonymous" for a deploy with no credential: there is no label and
      // no person to name, but history should still say so rather than
      // leave the column blank.
      triggeredBy: actor.triggeredBy ?? "anonymous",
      // From the credential, not the request: a proxy_auth_token is a
      // person in the dashboard, a deploy token is an agent/CI/script —
      // and so is an anonymous deploy, which only ever comes from one.
      source: actor.kind === "proxyAuth" ? "dashboard" : "agent",
      agentName: actor.kind === "proxyAuth" ? null : body.agentName ?? null,
      finishedAt,
    });

    // Only on the row-creating call (a deploy STARTING), and only when a
    // person is actually behind it — a deploy token names a company, not
    // an actor, so there's no "who" worth writing down for it, and the
    // token's own label is already on the deployment row either way.
    // Skipped on the in_progress -> success/failed update so one upload
    // is one audit line, not two.
    if (actor.kind === "proxyAuth") {
      await logAudit({
        actorUserId: actor.userId,
        companyId: actor.companyId,
        projectId: project.id,
        action: "project.deploy",
        details: `uploaded ${deployment.version} (${body.appVersion})`,
      });
    }
  }

  // body.memoryMb here is hostnsoft-deploy's actual applied taskMemory —
  // already floor-adjusted for embedded-DB apps (see server.js's
  // Math.max(autoDetectedMemory, ...)). Project.memoryMb previously only
  // ever changed via the explicit PATCH .../memory endpoint, so an
  // embedded-DB app that never touched that setting stayed stuck at the
  // schema default (256) in the DB forever despite actually running at
  // 512 — which customDomainActivation.ts's pushCustomDomainConfig would
  // then read as gospel and use to shrink the running app back down.
  // Persisting the real applied value here (never downward — an
  // explicit higher configured value must never be undercut by a lower
  // auto-detected one) keeps Project.memoryMb a source of truth instead
  // of a stale default.
  //
  // currentDeploymentId is set unconditionally on every success (not
  // just when memory changed) — this is what "the version currently
  // live" actually means, and it must move forward on this row's own
  // success even if a later attempt for a DIFFERENT deployment id fails
  // (deploymentId lets an in_progress row be updated in place; a stale
  // in-flight update finishing after a newer one already succeeded is
  // not a case this endpoint needs to guard against today).
  if (body.status === "success") {
    await markProjectDeploymentLive(
      project.id,
      deployment.id,
      body.memoryMb,
      project.memoryMb,
      body.kind
    );
  }

  res.status(201).json(deployment);
});

const completeSchema = z.object({
  success: z.boolean(),
  errorDetail: z.string().optional(),
});

// Called by hostnsoft-deploy once an ASYNC config-push it accepted
// (POST /internal/apps/:appName/config with a deploymentId — currently
// only one-click rollback does this, see deployments.routes.ts) actually
// finishes applying — the config-push endpoint itself now responds 202
// the moment it's confirmed the target image exists, same "accept fast,
// report the real outcome later" shape as a fresh deploy's own
// POST /apps -> /internal/deployments/record round trip. Authenticated
// with the shared INTERNAL_API_SECRET rather than a deploy token: unlike
// a real deploy, a config-push has no per-company deploy token in hand
// at all (hostnsoft-api called INTO hostnsoft-deploy with
// INTERNAL_API_SECRET in the first place — see customDomainActivation.ts).
internalDeploymentsRouter.post(
  "/internal/deployments/:deploymentId/complete",
  requireInternalSecret,
  async (req, res) => {
    const body = completeSchema.parse(req.body);

    const deployment = await prisma.deployment.findUnique({ where: { id: req.params.deploymentId } });
    if (!deployment) {
      return res.status(404).json({ error: "Deployment not found" });
    }

    const updated = await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: body.success ? "success" : "failed",
        errorDetail: body.errorDetail,
        finishedAt: new Date(),
      },
    });

    if (body.success) {
      const project = await prisma.project.findUniqueOrThrow({ where: { id: deployment.projectId } });
      await markProjectDeploymentLive(project.id, updated.id, updated.memoryMb, project.memoryMb);
    }

    res.json(updated);
  }
);
