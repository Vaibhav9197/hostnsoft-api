import { Router } from "express";
import { healthRouter } from "./health.routes";
import { authRouter } from "./auth.routes";
import { companiesRouter } from "./companies.routes";
import { tokensRouter } from "./tokens.routes";
import { projectsRouter } from "./projects.routes";
import { deploymentsRouter } from "./deployments.routes";
import { envVarsRouter } from "./envVars.routes";

export const router = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(companiesRouter);
router.use(tokensRouter);
router.use(projectsRouter);
router.use(deploymentsRouter);
router.use(envVarsRouter);
