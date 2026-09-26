/**
 * The agent-facing control plane: everything an AI agent needs to operate
 * an app it deployed, authenticated with the deploy token it already has
 * and addressed by the app name it already knows.
 *
 * These are the same operations the dashboard performs, on the same
 * services — not a parallel implementation. What differs is only
 * addressing and authentication (see middleware/deployTokenContext.ts).
 * Until this existed, an agent could deploy an app and then could not fix
 * it: env vars and rollback were reachable only with a dashboard session
 * credential, so the most common production problems required a human.
 *
 * Mounted BEFORE every requireProxyToken router in routes/index.ts — see
 * the ordering comment there; those routers 401 anything that reaches
 * them, regardless of path.
 *
 * Reachable at https://ship.embarko.ai/api/apps/... — Traefik strips the
 * /api prefix before the request arrives, so paths here omit it (same as
 * publicTokens.routes.ts).
 */
// Request/Response come from express explicitly: the bare globals resolve
// to the DOM's fetch types, which silently typecheck as the wrong shape.
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { isUniqueConstraintViolation } from "../lib/prismaErrors";
import { requireDeployToken, loadAppBySlug, loadAppById } from "../middleware/deployTokenContext";
import { startSlugChange, resolveSlugChangeStatus, SLUG_CHANGE_STATUS } from "../services/slugChangeFlow";
import { cooldownRemainingMs as slugChangeCooldownRemainingMs } from "../services/projectSlugChange";
import { platformAppUrl } from "../services/showcase";
import { logAudit } from "../services/audit";
import { applyCurrentConfig, rollbackToDeployment, type RedeployOutcome } from "../services/redeploy";
import {
  agentShowcaseSubmissionSchema,
  canListOn,
  collectionSummary,
  normalizeTags,
  resolveAppUrl,
  toOwnerProject,
  uniqueProjectSlug,
} from "../services/showcase";
import { classifyDomain, isValidDomainSyntax, type DomainType } from "../lib/customDomain";
import { verifyDomainDns } from "../lib/dnsVerify";
import { activateDomain, pushCustomDomainConfig } from "../services/customDomainActivation";
import { EDGE_HOSTNAME, ORIGIN_SERVER_IP, platformZoneOf } from "../lib/customDomainConfig";
import { fetchAppAnalytics, type AnalyticsRange } from "../services/appAnalytics";
import { tearDownApp } from "../services/appTeardown";

export const agentAppsRouter = Router();

// mergeParams so handlers below see :appName from the mount path. Without
// it they'd read req.params.appName as undefined and every lookup would
// 404 — the sub-router pattern makes that guarantee explicit rather than
// relying on how Express populates params for a path-mounted .use().
const appScoped = Router({ mergeParams: true });
appScoped.use(requireDeployToken, loadAppBySlug);

// Where an address change reports its outcome. Addressed by project id,
// NOT by name, and therefore deliberately outside the /apps/:appName
// tree: the name is the thing in motion. During a migration the old name
// still resolves and the new one does not (this service writes the new
// slug only once the move succeeds), and afterwards it is the other way
// round — so a name-addressed status URL would be answering about a
// moving target. The id is stable across all of it, and the agent
// already has one: GET /apps/:appName returns it.
//
// Registered before the mount below because Express matches in order,
// and because loadAppBySlug — which this must not use — is applied to
// everything under it.
agentAppsRouter.get("/slug-changes/:projectId", requireDeployToken, loadAppById, async (req, res) => {
  res.json(await resolveSlugChangeStatus(req.project!));
});

agentAppsRouter.use("/apps/:appName", appScoped);

// Records who did it, so deployment history and the audit log can tell a
// person clicking in the dashboard from an agent acting on a token. The
// token's label is what the owner named it, which is the useful half.
function agentActor(req: Pick<Request, "deployToken">): string {
  return `agent:${req.deployToken!.label}`;
}

// The app itself — its stable id, its URL, and what's currently live.
// An agent that only ever knew the name now has an id it can hold onto.
appScoped.get("/", async (req, res) => {
  const project = req.project!;
  const current = project.currentDeploymentId
    ? await prisma.deployment.findUnique({ where: { id: project.currentDeploymentId } })
    : null;

  res.json({
    id: project.id,
    name: project.slug,
    memoryMb: project.memoryMb,
    createdAt: project.createdAt,
    currentDeployment: current && {
      id: current.id,
      version: current.version,
      appVersion: current.appVersion,
      status: current.status,
      finishedAt: current.finishedAt,
    },
  });
});

const renameAppSchema = z.object({ name: z.string().min(1) });

// Display name only — the slug (and so the live URL) never changes after
// creation, same as projects.routes.ts's rename.
appScoped.patch("/", async (req, res) => {
  const { name } = renameAppSchema.parse(req.body);
  const project = await prisma.project.update({ where: { id: req.project!.id }, data: { name } });

  await logAudit({
    actorUserId: req.userId,
    companyId: req.company!.id,
    projectId: project.id,
    action: "project.rename",
    details: `${name} (${agentActor(req)})`,
  });

  res.json({ id: project.id, name: project.name, slug: project.slug });
});

// Irreversible, no backup — see limitations-and-recommendations.md. A
// deploy token can be requested by email alone (no further verification),
// so this requires an explicit confirmation on top of the token itself:
// naming the app again is cheap for an agent that means it, and costly
// for one acting on a misread instruction.
const deleteAppSchema = z.object({ confirmAppName: z.string().min(1) });

appScoped.delete("/", async (req, res) => {
  const { confirmAppName } = deleteAppSchema.parse(req.body ?? {});
  const project = req.project!;

  if (confirmAppName !== project.slug) {
    return res.status(400).json({
      error: `Deleting is irreversible. Resend with { "confirmAppName": "${project.slug}" } to confirm.`,
      code: "confirmation_required",
    });
  }

  await tearDownApp(project.slug);
  await prisma.project.delete({ where: { id: project.id } });

  await logAudit({
    actorUserId: req.userId,
    companyId: req.company!.id,
    projectId: project.id,
    action: "project.delete",
    details: agentActor(req),
  });

  res.status(204).end();
});

// Keys only, never values.
//
// Env vars double as this platform's secret store (there is no separate
// one — /capabilities reports secrets as unavailable), so returning
// values here would pull customer credentials into an agent's context,
// which is transcribed, summarised and often retained. An agent needs to
// know WHICH vars are set in order to reason about configuration; it
// never needs to read one back in order to change it. The dashboard,
// where a person is looking at their own screen, still shows values.
appScoped.get("/env-vars", async (req, res) => {
  const envVars = await prisma.envVar.findMany({
    where: { projectId: req.project!.id },
    select: { key: true, updatedAt: true },
    orderBy: { key: "asc" },
  });
  res.json({
    vars: envVars.map((v) => ({ key: v.key, set: true, updatedAt: v.updatedAt })),
    valuesReadable: false,
  });
});

// Same pattern as envVars.routes.ts — hostnsoft-deploy embeds `key` as a
// bare, unquoted attribute name in generated Nomad job-spec HCL, so an
// unrestricted key could inject job-spec content. This is the enforcement
// point on the agent path; the value side is safe inside a quoted literal.
const ENV_VAR_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const upsertEnvVarsSchema = z.object({
  vars: z
    .array(
      z.object({
        key: z
          .string()
          .min(1)
          .regex(ENV_VAR_KEY_PATTERN, "Must be a valid env var name (letters, digits, underscore; can't start with a digit)"),
        value: z.string(),
      })
    )
    .min(1),
  // Opt in to making the change reach the running container immediately.
  apply: z.boolean().optional().default(false),
});

// Maps a failed re-push to a response. Shared by the apply paths and
// rollback so the same condition never reports two different ways.
function sendRedeployFailure(res: Response, outcome: Extract<RedeployOutcome, { ok: false }>) {
  switch (outcome.code) {
    case "deployment_not_found":
      return res.status(404).json({ error: "Deployment not found", code: "deployment_not_found" });
    case "rollback_not_successful_deployment":
      return res.status(422).json({
        error: "Can only roll back to a past successful deployment that has an image.",
        code: "rollback_not_successful_deployment",
      });
    case "no_current_deployment":
      return res.status(422).json({
        error: "This app has no successful deployment to re-apply configuration to. Deploy it first.",
        code: "no_current_deployment",
      });
    case "rollback_image_unavailable":
      return res.status(422).json({
        error: `That image is no longer on disk. Rollback only reaches the last ${outcome.retainCount} deployments.`,
        code: "rollback_image_unavailable",
        retainCount: outcome.retainCount,
      });
    case "rename_in_progress":
      // The app's address is moving right now, which means its Nomad job
      // is being stopped and recreated under a new name. Pushing into
      // that window targets a job that is going away. Retryable, unlike
      // most 409s here — say so.
      return res.status(409).json({
        error:
          "This app's address is being changed right now. Wait for that to finish, then try again — " +
          "the app may answer to a new name afterwards.",
        code: "rename_in_progress",
      });
    // Narrows to rollback_push_failed once every other member is handled.
    default:
      return res.status(502).json({ error: `Re-deploy failed: ${outcome.error}`, code: "rollback_push_failed" });
  }
}

// A merge, not a replace: vars absent from the body are left alone. An
// agent setting one variable can't silently drop the rest.
//
// `apply: true` makes the change take effect immediately by re-pushing the
// running image with the new values — no rebuild, no source upload. That
// matters because the variable an app is missing is often the reason it
// can't boot, and an agent has no source to re-upload in that situation.
// Default false so an agent writing several variables can batch them and
// pay one restart.
appScoped.put("/env-vars", async (req, res) => {
  const { vars, apply } = upsertEnvVarsSchema.parse(req.body);
  const projectId = req.project!.id;
  const actor = req.userId!;

  await prisma.$transaction(
    vars.map(({ key, value }) =>
      prisma.envVar.upsert({
        where: { projectId_key: { projectId, key } },
        update: { value, updatedBy: actor },
        create: { projectId, key, value, createdBy: actor, updatedBy: actor },
      })
    )
  );

  await logAudit({
    actorUserId: actor,
    companyId: req.company!.id,
    projectId,
    action: "env_var.upsert",
    details: `${vars.map((v) => v.key).join(", ")} (${agentActor(req)})`,
  });

  const written = vars.map((v) => ({ key: v.key, set: true }));

  // Stated rather than assumed: env vars are baked into the Nomad job
  // spec at deploy time, so writing one does NOT reach the running
  // container by itself. An agent that sets a variable and reports success
  // without applying has left the app exactly as broken as it found it.
  if (!apply) {
    return res.json({ vars: written, applied: false, appliesOn: "next_deploy" });
  }

  const outcome = await applyCurrentConfig(req.project!, `config:${agentActor(req)}`);
  if (!outcome.ok) {
    // The values ARE saved — only applying them failed. Say so, or an
    // agent retries the write it already completed.
    if (outcome.code === "no_current_deployment") {
      return res.status(422).json({
        error: "Saved, but there's no running deployment to apply them to. Deploy the app to pick them up.",
        code: "no_current_deployment",
        vars: written,
        applied: false,
        appliesOn: "next_deploy",
      });
    }
    return sendRedeployFailure(res, outcome);
  }

  res.status(202).json({
    vars: written,
    applied: true,
    deploymentId: outcome.deployment.id,
    statusUrl: `/api/apps/${req.project!.slug}/deployments/${outcome.deployment.id}`,
    terminal: false,
  });
});

// Apply configuration already saved — the same re-push, without changing
// anything first. This is what follows a DELETE, or several separate
// writes an agent wants to land in one restart.
appScoped.post("/env-vars/apply", async (req, res) => {
  const outcome = await applyCurrentConfig(req.project!, `config:${agentActor(req)}`);
  if (!outcome.ok) return sendRedeployFailure(res, outcome);

  await logAudit({
    actorUserId: req.userId,
    companyId: req.company!.id,
    projectId: req.project!.id,
    action: "project.config_apply",
    details: agentActor(req),
  });

  res.status(202).json({
    applied: true,
    deploymentId: outcome.deployment.id,
    statusUrl: `/api/apps/${req.project!.slug}/deployments/${outcome.deployment.id}`,
    terminal: false,
  });
});

// Update (or create) one variable, addressed by name.
//
// The bulk PUT above can do this with a one-element array, but an agent
// changing a single value shouldn't have to build a collection to do it,
// and addressing the variable by name is what makes the intent obvious in
// a log and an audit entry. Upserts rather than requiring prior existence:
// PUT on a named resource means "make it have this value", and an agent
// that had to check existence first would pay a turn to learn something
// the write itself can settle.
const updateEnvVarSchema = z.object({
  value: z.string(),
  apply: z.boolean().optional().default(false),
});

appScoped.put("/env-vars/:key", async (req, res) => {
  const key = req.params.key;
  // The key arrives as a path segment here rather than through the body
  // schema, so it needs the same check: hostnsoft-deploy embeds it as a
  // bare attribute name in generated Nomad HCL, and this endpoint can
  // CREATE a variable, so an unvalidated key would reach that job spec.
  if (!ENV_VAR_KEY_PATTERN.test(key)) {
    return res.status(400).json({
      error: "Must be a valid env var name (letters, digits, underscore; can't start with a digit).",
      code: "invalid_env_var_key",
    });
  }

  const { value, apply } = updateEnvVarSchema.parse(req.body);
  const projectId = req.project!.id;
  const actor = req.userId!;

  const existing = await prisma.envVar.findUnique({ where: { projectId_key: { projectId, key } } });
  await prisma.envVar.upsert({
    where: { projectId_key: { projectId, key } },
    update: { value, updatedBy: actor },
    create: { projectId, key, value, createdBy: actor, updatedBy: actor },
  });

  await logAudit({
    actorUserId: actor,
    companyId: req.company!.id,
    projectId,
    action: existing ? "env_var.update" : "env_var.upsert",
    details: `${key} (${agentActor(req)})`,
  });

  const written = { key, set: true, created: !existing };

  if (!apply) {
    return res.json({ ...written, applied: false, appliesOn: "next_deploy" });
  }

  const outcome = await applyCurrentConfig(req.project!, `config:${agentActor(req)}`);
  if (!outcome.ok) {
    // The value IS saved — only applying it failed. Say so, or an agent
    // retries a write that already succeeded.
    if (outcome.code === "no_current_deployment") {
      return res.status(422).json({
        ...written,
        error: "Saved, but there's no running deployment to apply it to. Deploy the app to pick it up.",
        code: "no_current_deployment",
        applied: false,
        appliesOn: "next_deploy",
      });
    }
    return sendRedeployFailure(res, outcome);
  }

  res.status(202).json({
    ...written,
    applied: true,
    deploymentId: outcome.deployment.id,
    statusUrl: `/api/apps/${req.project!.slug}/deployments/${outcome.deployment.id}`,
    terminal: false,
  });
});

appScoped.delete("/env-vars/:key", async (req, res) => {
  const projectId = req.project!.id;
  const existing = await prisma.envVar.findUnique({
    where: { projectId_key: { projectId, key: req.params.key } },
  });
  if (!existing) {
    return res.status(404).json({ error: `No env var named "${req.params.key}".`, code: "env_var_not_found" });
  }

  await prisma.envVar.delete({ where: { projectId_key: { projectId, key: req.params.key } } });

  await logAudit({
    actorUserId: req.userId,
    companyId: req.company!.id,
    projectId,
    action: "env_var.delete",
    details: `${req.params.key} (${agentActor(req)})`,
  });
  res.status(204).end();
});

// The app's name IS its address, so this is a rename and a migration at
// once: a new hostname, a new Nomad job, a new certificate, and the old
// address gone with no redirect.
//
// `newName`, not `slug`: this surface calls it a name everywhere — the
// header is X-App-Name, GET / returns `name`, the failures are
// app_name_taken and app_not_found — and hostnsoft-deploy's own wire
// field for this is newName too. `slug` is dashboard vocabulary.
//
// No confirmation flag: a model that has decided to call will set a
// boolean anyway. What does guard against stale information is the path
// — if something moved this app first, `:appName` no longer resolves and
// the call fails app_renamed instead of renaming the wrong thing.
const slugChangeSchema = z.object({ newName: z.string().trim().min(1).max(63) });

appScoped.post("/slug-change", async (req, res) => {
  const project = req.project!;
  const { newName } = slugChangeSchema.parse(req.body ?? {});

  const started = await startSlugChange({
    project,
    requestedSlug: newName,
    companyId: req.company!.id,
    actorUserId: req.userId,
    actorNote: agentActor(req),
  });

  if (!started.ok) {
    const body: Record<string, unknown> = { error: started.reason, code: started.code };
    // A cooldown is the one refusal that resolves purely by waiting, so
    // say how long in a field rather than only in prose a machine would
    // have to parse out of a sentence.
    if (started.code === "slug_change_cooldown") {
      const retryAfterMs = await slugChangeCooldownRemainingMs(project.id);
      body.retryAfterMs = retryAfterMs;
      res.set("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
    }
    return res.status(SLUG_CHANGE_STATUS[started.code]).json(body);
  }

  // Everything the caller needs to update its own state, because the
  // thing that just changed is how it addresses this app at all.
  const describe = (name: string) => ({
    projectId: project.id,
    name,
    // createdAt too: since the domain move the suffix depends on whether
    // the app predates the cutover, and without it this answers
    // embarko.app while GET /apps/<name> answers app.embarko.ai.
    appUrl: platformAppUrl(name, project.createdAt),
    // The commonest next action after a rename is a deploy, and the
    // commonest way to break it is sending the old app name. Spell it
    // out rather than making an agent infer it.
    deployWith: { "X-App-Name": name },
  });

  if (started.kind === "unchanged") {
    return res.json({ ...describe(project.slug), moved: false, terminal: true });
  }

  if (started.kind === "applied") {
    return res.json({
      ...describe(started.project.slug),
      moved: true,
      from: started.previousSlug,
      terminal: true,
      oldAddressStops: true,
    });
  }

  // Live: the migration is running behind this response.
  const domains = await prisma.domain.findMany({
    where: { projectId: project.id, status: "active" },
    select: { domain: true },
  });

  res.status(202).json({
    ...describe(started.to),
    moving: true,
    terminal: false,
    from: started.from,
    to: started.to,
    statusUrl: `/api/slug-changes/${project.id}`,
    // True and worth stating: the rename carries active custom domains
    // over to the new job, so for an app that has one, its canonical
    // public address does not change at all.
    customDomainsUnaffected: domains.map((d) => d.domain),
    oldAddressStops: true,
  });
});

// Deployment history — what a rollback needs in order to pick a target.
appScoped.get("/deployments", async (req, res) => {
  const project = req.project!;
  const deployments = await prisma.deployment.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json({
    deployments: deployments.map((d) => ({
      id: d.id,
      version: d.version,
      appVersion: d.appVersion,
      status: d.status,
      isCurrent: d.id === project.currentDeploymentId,
      // Whether this row is a legal rollback target, so an agent doesn't
      // have to infer the rule from status and imageTag separately.
      rollbackTarget: d.status === "success" && !!d.imageTag && d.id !== project.currentDeploymentId,
      createdAt: d.createdAt,
      finishedAt: d.finishedAt,
      triggeredBy: d.triggeredBy,
    })),
  });
});

// One deployment — what the rollback response's statusUrl points at.
appScoped.get("/deployments/:deploymentId", async (req, res) => {
  const project = req.project!;
  const deployment = await prisma.deployment.findFirst({
    where: { id: req.params.deploymentId, projectId: project.id },
  });
  if (!deployment) {
    return res.status(404).json({ error: "Deployment not found", code: "deployment_not_found" });
  }
  res.json({
    id: deployment.id,
    version: deployment.version,
    appVersion: deployment.appVersion,
    status: deployment.status,
    terminal: deployment.status !== "in_progress",
    isCurrent: deployment.id === project.currentDeploymentId,
    errorDetail: deployment.errorDetail,
    createdAt: deployment.createdAt,
    finishedAt: deployment.finishedAt,
  });
});

// `deploymentId` omitted means "undo the last deploy" — the most recent
// successful, still-rollbackable deployment that isn't the current one.
// Agents overwhelmingly want that rather than a specific past version, and
// making them list history first just to name it costs a turn and invites
// picking an invalid target.
const rollbackSchema = z.object({ deploymentId: z.string().min(1).optional() });

appScoped.post("/rollback", async (req, res) => {
  const project = req.project!;
  const { deploymentId } = rollbackSchema.parse(req.body ?? {});

  let targetId = deploymentId;
  if (!targetId) {
    const previous = await prisma.deployment.findFirst({
      where: {
        projectId: project.id,
        status: "success",
        imageTag: { not: null },
        id: { not: project.currentDeploymentId ?? undefined },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!previous) {
      return res.status(422).json({
        error: "There is no earlier successful deployment to roll back to.",
        code: "no_rollback_target",
      });
    }
    targetId = previous.id;
  }

  const outcome = await rollbackToDeployment(project, targetId, agentActor(req));

  if (!outcome.ok) return sendRedeployFailure(res, outcome);

  await logAudit({
    actorUserId: req.userId,
    companyId: req.company!.id,
    projectId: project.id,
    action: "project.rollback",
    details: `to ${outcome.target.version} (${outcome.target.imageTag}) (${agentActor(req)})`,
  });

  // 202, not 200: Nomad hasn't applied it yet. statusUrl is an
  // agent-reachable path — the dashboard's equivalent returns a
  // /companies/:id/projects/:id/... URL this caller can't call.
  res.status(202).json({
    accepted: true,
    deploymentId: outcome.deployment.id,
    rolledBackTo: { id: outcome.target.id, version: outcome.target.version },
    statusUrl: `/api/apps/${project.slug}/deployments/${outcome.deployment.id}`,
    terminal: false,
  });
});

// Custom domains — same services domains.routes.ts calls for the
// dashboard (customDomainActivation.ts, dnsVerify.ts), just addressed by
// app name and deploy-token authenticated. The DNS record itself still
// has to be created by a person at their own registrar; what this opens
// up is the register/verify/delete calls around that step, so an agent
// doesn't have to hand the whole flow to a human.
function dnsInstructionsFor(domain: string, type: DomainType) {
  return type === "apex"
    ? { type: "A" as const, name: domain, value: ORIGIN_SERVER_IP }
    : { type: "CNAME" as const, name: domain, value: EDGE_HOSTNAME };
}

const registerDomainSchema = z.object({ domain: z.string().min(1) });

appScoped.get("/domains", async (req, res) => {
  const domains = await prisma.domain.findMany({ where: { projectId: req.project!.id } });
  res.json({ domains });
});

appScoped.post("/domains", async (req, res) => {
  const { domain: rawDomain } = registerDomainSchema.parse(req.body);
  const domain = rawDomain.toLowerCase().trim();

  if (!isValidDomainSyntax(domain)) {
    return res.status(400).json({ error: "Not a valid domain name", code: "invalid_domain" });
  }
  const platformZone = platformZoneOf(domain);
  if (platformZone) {
    return res.status(400).json({
      error: `"${domain}" is part of ${platformZone} and can't be registered as a custom domain. Use a domain you own.`,
      code: "domain_reserved",
    });
  }

  const type = classifyDomain(domain);

  let created;
  try {
    created = await prisma.domain.create({ data: { projectId: req.project!.id, domain, type } });
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err;
    return res.status(409).json({ error: `"${domain}" is already registered to a project`, code: "domain_taken" });
  }

  await logAudit({
    actorUserId: req.userId,
    companyId: req.company!.id,
    projectId: req.project!.id,
    action: "domain.register",
    details: `${domain} (${agentActor(req)})`,
  });

  res.status(201).json({
    domain: created.domain,
    status: created.status,
    instructions: dnsInstructionsFor(created.domain, created.type as DomainType),
  });
});

appScoped.post("/domains/:domain/verify", async (req, res) => {
  const domain = await prisma.domain.findFirst({
    where: { domain: req.params.domain, projectId: req.project!.id },
  });
  if (!domain) return res.status(404).json({ error: "Domain not found", code: "domain_not_found" });

  const type = domain.type as DomainType;
  const dnsOk = await verifyDomainDns(domain.domain, type);

  if (!dnsOk) {
    await prisma.domain.update({ where: { id: domain.id }, data: { status: "failed" } });
    return res.status(422).json({
      domain: domain.domain,
      status: "failed",
      error: "DNS does not yet point at the platform — check the instructions below and retry once it propagates",
      instructions: dnsInstructionsFor(domain.domain, type),
    });
  }

  const result = await activateDomain(domain.id);
  if (!result.activated) {
    return res.status(502).json({
      domain: domain.domain,
      status: "pending_dns",
      error: `DNS verified, but activating routing failed: ${result.error}`,
    });
  }

  await logAudit({
    actorUserId: req.userId,
    companyId: req.company!.id,
    projectId: req.project!.id,
    action: "domain.verify",
    details: `${domain.domain} (${agentActor(req)})`,
  });

  res.json({ domain: domain.domain, status: "active" });
});

appScoped.delete("/domains/:domain", async (req, res) => {
  const domain = await prisma.domain.findFirst({
    where: { domain: req.params.domain, projectId: req.project!.id },
  });
  if (!domain) return res.status(404).json({ error: "Domain not found", code: "domain_not_found" });

  await prisma.domain.delete({ where: { id: domain.id } });
  await pushCustomDomainConfig(domain.projectId);

  await logAudit({
    actorUserId: req.userId,
    companyId: req.company!.id,
    projectId: req.project!.id,
    action: "domain.delete",
    details: `${domain.domain} (${agentActor(req)})`,
  });

  res.status(204).end();
});

// Analytics — read-only, same fetchAppAnalytics as analytics.routes.ts.
// 503, not a fabricated empty result, when hostnsoft-deploy's analytics
// subsystem is unreachable — see analytics.routes.ts for why.
const analyticsRangeSchema = z.enum(["24h", "7d", "30d", "90d", "all"]).default("24h");

appScoped.get("/analytics", async (req, res) => {
  const range: AnalyticsRange = analyticsRangeSchema.parse(req.query.range);
  const analytics = await fetchAppAnalytics(req.project!.slug, range);
  if (!analytics) {
    return res.status(503).json({ error: "Analytics are temporarily unavailable for this app" });
  }
  res.json(analytics);
});

const SHOWCASE_COLLECTION_UNKNOWN = {
  error: "That showcase page doesn't exist",
  code: "SHOWCASE_COLLECTION_UNKNOWN",
} as const;

// List (or update) this app on a showcase page — the agent-facing half of
// what the dashboard's POST /companies/:companyId/showcase/submissions
// does, addressed by app name instead of a projectId the agent doesn't
// have. PUT rather than POST: calling it again with new details updates the
// existing listing instead of erroring, since an agent iterating on
// tagline/screenshot shouldn't have to look up and delete first.
appScoped.put("/showcase", async (req, res) => {
  const body = agentShowcaseSubmissionSchema.parse(req.body);
  const project = req.project!;

  const collection = await prisma.showcaseCollection.findUnique({ where: { slug: body.collectionSlug } });
  if (!collection) return res.status(404).json(SHOWCASE_COLLECTION_UNKNOWN);
  if (!canListOn(collection, req.company!.id)) {
    return res.status(403).json({
      error: `/showcase/${collection.slug} is a company's own page; only its apps can be listed there`,
      code: "SHOWCASE_COLLECTION_PRIVATE",
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

  const existing = await prisma.showcaseProject.findUnique({
    where: { collectionId_projectId: { collectionId: collection.id, projectId: project.id } },
  });

  if (existing) {
    const listing = await prisma.showcaseProject.update({ where: { id: existing.id }, data });
    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      projectId: project.id,
      action: "showcase.listing.update",
      details: `${listing.slug} -> /showcase/${collection.slug} (${agentActor(req)})`,
    });
    return res.json(toOwnerProject(listing, collectionSummary(collection)));
  }

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

  await logAudit({
    actorUserId: req.userId,
    companyId: req.company!.id,
    projectId: project.id,
    action: "showcase.listing.create",
    details: `${listing!.slug} -> /showcase/${collection.slug} (${agentActor(req)})`,
  });
  res.status(201).json(toOwnerProject(listing!, collectionSummary(collection)));
});
