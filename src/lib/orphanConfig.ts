/**
 * Config for anonymous ("orphan") deploys — see
 * docs/Anonymous-deploy-req.md. Both have sensible defaults, so these
 * are soft-configurable (env override optional) rather than fail-fast
 * required, unlike src/lib/internalDeployClient.ts's secrets/URLs.
 */

// How long an unclaimed orphan project lives before the cleanup job
// deletes it. Computed once per project at creation time (see
// src/services/projectClaim.ts) — changing this only affects projects
// created after the change.
export const ORPHAN_TTL_MS: number = process.env.ORPHAN_TTL_MS
  ? Number(process.env.ORPHAN_TTL_MS)
  : 24 * 60 * 60 * 1000;

// How often the cleanup job checks for expired orphan projects.
export const ORPHAN_CLEANUP_INTERVAL_MS: number = process.env.ORPHAN_CLEANUP_INTERVAL_MS
  ? Number(process.env.ORPHAN_CLEANUP_INTERVAL_MS)
  : 60 * 60 * 1000;
