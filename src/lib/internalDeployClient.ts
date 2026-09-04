/**
 * Config for this service's own calls INTO hostnsoft-deploy — the
 * reverse direction of the deploy-token flow (which authenticates
 * hostnsoft-deploy calling INTO this service instead). Shared by every
 * feature that needs to push/pull something from hostnsoft-deploy after
 * the fact: custom-domain router activation (docs/Customdomain-req.md)
 * and orphan-project teardown (docs/Anonymous-deploy-req.md). Fail-fast
 * at startup, same convention as src/lib/msg91.ts.
 */

if (!process.env.HOSTNSOFT_DEPLOY_URL) {
  throw new Error(
    "HOSTNSOFT_DEPLOY_URL environment variable is not set. Required for this " +
      "service's own calls into hostnsoft-deploy."
  );
}
export const HOSTNSOFT_DEPLOY_URL: string = process.env.HOSTNSOFT_DEPLOY_URL;

if (!process.env.INTERNAL_API_SECRET) {
  throw new Error(
    "INTERNAL_API_SECRET environment variable is not set. This authenticates " +
      "hostnsoft-api's own calls INTO hostnsoft-deploy — must match " +
      "hostnsoft-deploy's INTERNAL_API_SECRET exactly."
  );
}
export const INTERNAL_API_SECRET: string = process.env.INTERNAL_API_SECRET;
