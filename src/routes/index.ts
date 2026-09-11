import { Router } from "express";
import { healthRouter } from "./health.routes";
import { internalTokensRouter } from "./internalTokens.routes";
import { internalProjectsRouter } from "./internalProjects.routes";
import { internalDeploymentsRouter } from "./internalDeployments.routes";
import { internalCustomerQueryRouter } from "./internalCustomerQuery.routes";
import { publicTokensRouter } from "./publicTokens.routes";
import { publicCustomerQueryRouter } from "./publicCustomerQuery.routes";
import { publicDocsRouter } from "./publicDocs.routes";
import { connectorAuthRouter } from "./connectorAuth.routes";
import { authRouter } from "./auth.routes";
import { companiesRouter } from "./companies.routes";
import { tokensRouter } from "./tokens.routes";
import { projectsRouter } from "./projects.routes";
import { deploymentsRouter } from "./deployments.routes";
import { envVarsRouter } from "./envVars.routes";
import { domainsRouter } from "./domains.routes";
import { billingRouter } from "./billing.routes";
import { analyticsRouter } from "./analytics.routes";
import { adminRouter } from "./admin.routes";
import { customerQueryRouter } from "./customerQuery.routes";

export const router = Router();

// healthRouter, every internal*Router, every public*Router and
// connectorAuthRouter carry no `.use(requireProxyToken)` of their own and
// MUST stay mounted before any router below — each router below calls
// `.use(requireProxyToken)` unconditionally on itself, and since every router
// here mounts at "/", that blanket check runs (and can short-circuit the
// whole chain with a 401) for ANY request that reaches it first,
// regardless of whether the request's path even belongs to that router.
router.use(healthRouter);
router.use(internalTokensRouter);
router.use(internalProjectsRouter);
router.use(internalDeploymentsRouter);
router.use(internalCustomerQueryRouter);
router.use(publicTokensRouter);
router.use(publicCustomerQueryRouter);
router.use(publicDocsRouter);
router.use(connectorAuthRouter);

router.use(authRouter);
router.use(companiesRouter);
router.use(tokensRouter);
router.use(projectsRouter);
router.use(deploymentsRouter);
router.use(envVarsRouter);
router.use(domainsRouter);
router.use(billingRouter);
router.use(analyticsRouter);
router.use(adminRouter);
router.use(customerQueryRouter);
