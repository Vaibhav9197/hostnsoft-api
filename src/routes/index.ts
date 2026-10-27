import { Router } from "express";
import { healthRouter } from "./health.routes";
import { internalTokensRouter } from "./internalTokens.routes";
import { internalProjectsRouter } from "./internalProjects.routes";
import { internalDeploymentsRouter } from "./internalDeployments.routes";
import { internalCustomerQueryRouter } from "./internalCustomerQuery.routes";
import { internalProxyAuthRouter } from "./internalProxyAuth.routes";
import { publicTokensRouter } from "./publicTokens.routes";
import { publicCustomerQueryRouter } from "./publicCustomerQuery.routes";
import { publicDocsRouter } from "./publicDocs.routes";
import { publicShowcaseRouter } from "./publicShowcase.routes";
import { publicBillingRouter } from "./publicBilling.routes";
import { connectorAuthRouter } from "./connectorAuth.routes";
import { agentAppsRouter } from "./agentApps.routes";
import { authRouter } from "./auth.routes";
import { companiesRouter } from "./companies.routes";
import { membersRouter } from "./members.routes";
import { tokensRouter } from "./tokens.routes";
import { projectsRouter } from "./projects.routes";
import { schedulesRouter } from "./schedules.routes";
import { deploymentsRouter } from "./deployments.routes";
import { envVarsRouter } from "./envVars.routes";
import { integrationsRouter } from "./integrations.routes";
import { domainsRouter } from "./domains.routes";
import { billingRouter } from "./billing.routes";
import { internalBillingRouter } from "./internalBilling.routes";
import { analyticsRouter } from "./analytics.routes";
import { adminRouter } from "./admin.routes";
import { customerQueryRouter } from "./customerQuery.routes";
import { showcaseRouter } from "./showcase.routes";
import { adminShowcaseRouter } from "./adminShowcase.routes";

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
router.use(internalProxyAuthRouter);
router.use(internalBillingRouter);
router.use(publicTokensRouter);
router.use(publicCustomerQueryRouter);
router.use(publicShowcaseRouter);
router.use(publicDocsRouter);
router.use(publicBillingRouter);
router.use(connectorAuthRouter);
// Agent control plane: deploy-token auth, mounted with the other
// non-requireProxyToken routers per the ordering rule above.
router.use(agentAppsRouter);

router.use(authRouter);
router.use(companiesRouter);
router.use(membersRouter);
router.use(tokensRouter);
router.use(projectsRouter);
router.use(deploymentsRouter);
router.use(envVarsRouter);
router.use(integrationsRouter);
router.use(schedulesRouter);
router.use(domainsRouter);
router.use(billingRouter);
router.use(analyticsRouter);
router.use(customerQueryRouter);
router.use(showcaseRouter);

router.use(adminRouter);
router.use(adminShowcaseRouter);
