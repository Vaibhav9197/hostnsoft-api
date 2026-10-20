import type { Request } from "express";
import { z } from "zod";
import { ProxyError, isCompanyMember, verifyProxyAuthToken } from "../lib/msg91";
import { hasInternalSecret } from "../middleware/requireInternalSecret";
import { findLiveDeployToken, unauthorizedDeployTokenBody } from "./deployTokenAuth";

// Who a deploy is being made on behalf of, resolved once and shared by
// every internal (hostnsoft-deploy-facing) endpoint a deploy passes
// through: POST /internal/projects/claim before the build, and
// POST /internal/deployments/record around it.
//
// Three credential shapes reach those endpoints, and they are NOT
// interchangeable in how much they're trusted:
//
//   deploy token — the original path (agents, CI, the CLI). The raw
//     token IS the credential and IS the company identity, so no further
//     proof of who's calling is needed. Unchanged by this file's
//     existence.
//   proxy_auth_token — added 2026-09-17 so the dashboard's own upload
//     UI can deploy a tarball as the logged-in person, without first
//     making them mint a deploy token just to use the button in front of
//     them. A PAT is not company-scoped (a person can belong to several
//     companies), so the caller must also say WHICH company — and that
//     claim is verified here against proxy membership, never taken on
//     hostnsoft-deploy's word.
//   neither — the anonymous/orphan path (docs/Anonymous-deploy-req.md).
//     Deliberately reachable only by sending no credential at all; a
//     credential that's present and fails is an error, never a silent
//     downgrade to anonymous.
export type DeployActor =
  // tokenCreatedBy: the proxy user who minted the token — the person behind
  // an agent's deploy, for anything that needs one (schedule alerts).
  | { kind: "deployToken"; companyId: string; userId: null; triggeredBy: string; tokenCreatedBy: string }
  | { kind: "proxyAuth"; companyId: string; userId: string; triggeredBy: string }
  | { kind: "anonymous"; companyId: null; userId: null; triggeredBy: null };

export type DeployActorResult =
  | { ok: true; actor: DeployActor }
  // Status + body rather than a thrown error: these are all "the caller
  // presented something that doesn't check out" answers that each route
  // returns verbatim, alongside its own 409/404 responses.
  | { ok: false; status: number; body: Record<string, unknown> };

// The credential fields every deploy-facing internal endpoint accepts.
// All optional — which combination is present is what selects the path
// above — so each route spreads this into its own body schema.
export const deployCredentialFields = {
  token: z.string().min(1).optional(),
  // Sent together, or not at all. companyId is only read on the
  // proxy_auth_token path: a deploy token carries its own company and
  // must never be re-pointed at a different one by a header.
  proxyAuthToken: z.string().min(1).optional(),
  companyId: z.string().min(1).optional(),
};

export async function resolveDeployActor(
  req: Request,
  input: { token?: string; proxyAuthToken?: string; companyId?: string }
): Promise<DeployActorResult> {
  // Deploy token wins when both are somehow presented — same precedence
  // as hostnsoft-deploy's own authorizeAppAccess for status/logs, so no
  // existing agent/CI caller's behavior can change no matter what the
  // dashboard starts sending.
  if (input.token) {
    const record = await findLiveDeployToken(input.token);
    if (!record) {
      return { ok: false, status: 401, body: unauthorizedDeployTokenBody() };
    }
    return {
      ok: true,
      actor: {
        kind: "deployToken",
        companyId: record.companyId,
        userId: null,
        triggeredBy: record.label,
        tokenCreatedBy: record.createdBy,
      },
    };
  }

  if (input.proxyAuthToken) {
    // Gated by the shared internal secret, unlike the deploy-token
    // branch above (where knowing the raw token IS the credential) —
    // exactly the reasoning /internal/proxy-auth/verify-membership
    // already applies: a PAT is the credential that drives the entire
    // dashboard, far more powerful than a company-scoped deploy token,
    // so relaying one here additionally requires proof of being
    // hostnsoft-deploy. Checked before anything else so a caller without
    // the secret learns nothing about the PAT it sent.
    if (!hasInternalSecret(req)) {
      return { ok: false, status: 401, body: { error: "Unauthorized" } };
    }

    if (!input.companyId) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "companyId is required alongside proxyAuthToken",
          code: "company_id_required",
        },
      };
    }

    let identity;
    try {
      identity = await verifyProxyAuthToken(input.proxyAuthToken);
    } catch (err) {
      // A rejected PAT is this endpoint's own 401, not a 5xx. Anything
      // else (a proxy outage, PROXY_UNAVAILABLE) propagates to
      // errorHandler as the 503 it is — hostnsoft-deploy fails closed on
      // a non-2xx either way, but "identity service is down" must not be
      // reported to the person as "your login is invalid".
      if (err instanceof ProxyError && err.code === "PROXY_TOKEN_REJECTED") {
        return {
          ok: false,
          status: 401,
          body: { error: "Authentication failed", code: "PROXY_TOKEN_REJECTED" },
        };
      }
      throw err;
    }

    if (!(await isCompanyMember(identity.id, input.companyId))) {
      // 403, not the dashboard routes' 404-for-non-members: those hide
      // whether a company exists from an outsider probing by id, which
      // doesn't apply to a server-to-server call already holding the
      // internal secret. A person whose dashboard is pointed at a
      // company they've since been removed from should be told that,
      // not shown a deploy that mysteriously fails as "not found".
      return {
        ok: false,
        status: 403,
        body: {
          error: "That account is not a member of the workspace this app belongs to",
          code: "not_a_company_member",
        },
      };
    }

    return {
      ok: true,
      actor: {
        kind: "proxyAuth",
        companyId: input.companyId,
        userId: identity.id,
        // Deployment.triggeredBy holds "a proxy userId, or a deploy
        // token label" (see schema.prisma) — prefixed so history can
        // tell an upload from the dashboard apart from a token-driven
        // deploy whose label happens to look like an id.
        triggeredBy: `dashboard:${identity.id}`,
      },
    };
  }

  return { ok: true, actor: { kind: "anonymous", companyId: null, userId: null, triggeredBy: null } };
}

// The person a deploy acts for: the signed-in user, or a deploy token's
// creator. Null only for an anonymous deploy.
export function actorPersonId(actor: DeployActor): string | null {
  if (actor.kind === "deployToken") return actor.tokenCreatedBy;
  return actor.userId;
}
