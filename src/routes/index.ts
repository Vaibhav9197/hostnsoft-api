import { Router } from "express";
import { healthRouter } from "./health.routes";
import { internalTokensRouter } from "./internalTokens.routes";
import { authRouter } from "./auth.routes";
import { companiesRouter } from "./companies.routes";
import { tokensRouter } from "./tokens.routes";
import { projectsRouter } from "./projects.routes";
import { deploymentsRouter } from "./deployments.routes";
import { envVarsRouter } from "./envVars.routes";

export const router = Router();

// healthRouter and internalTokensRouter carry no auth requirement and
// MUST stay mounted before any router below — each of those calls
// `.use(requireAuth)` unconditionally on itself, and since every router
// here mounts at "/", that blanket check runs (and can short-circuit the
// whole chain with a 401) for ANY request that reaches it first,
// regardless of whether the request's path even belongs to that router.
router.use(healthRouter);
router.use(internalTokensRouter);

router.use(authRouter);
router.use(companiesRouter);
router.use(tokensRouter);
router.use(projectsRouter);
router.use(deploymentsRouter);
router.use(envVarsRouter);
