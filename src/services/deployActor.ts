import type { Request } from "express";
import type { Project } from "@prisma/client";
import { accessAllows, permissionDeniedBody, resolveAccess } from "../lib/permissions";
import { z } from "zod";
import { ProxyError, isCompanyMember, verifyProxyAuthToken } from "../lib/msg91";
import { hasInternalSecret } from "../middleware/requireInternalSecret";
import { findLiveDeployToken, tokenActorOf, unauthorizedDeployTokenBody, type TokenActor } from "./deployTokenAuth";
import type { AccessActor } from "./tokenAccess";

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
  // token: who the token acts as (deployTokenAuth.ts TokenActor) — for a
  // user-kind token, companyId is only its DEFAULT workspace, and which
  // existing apps it reaches is services/tokenAccess.ts's decision.
  | { kind: "deployToken"; companyId: string; userId: null; triggeredBy: string; tokenCreatedBy: string; token: TokenActor }
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
        token: tokenActorOf(record),
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

// The deploy's caller as services/tokenAccess.ts sees it. A dashboard upload
// is a person, but one who chose (and was verified for) a single workspace,
// so it reaches that workspace only — same as before user tokens. Null for
// an anonymous deploy, which has its own orphan path.
export function accessActorOfDeploy(actor: DeployActor): AccessActor | null {
  if (actor.kind === "deployToken") {
    return { kind: actor.token.kind, companyId: actor.token.companyId, userId: actor.token.userId };
  }
  if (actor.kind === "proxyAuth") return { kind: "workspace", companyId: actor.companyId, userId: actor.userId };
  return null;
}

// Who a new app made by this deploy is recorded as created by. A user token
// is a person, so it is them; a workspace token names nobody in particular
// (claimProjectForCompany's "hostnsoft-deploy" fallback), as before.
export function deployCreatedBy(actor: DeployActor): string | null {
  if (actor.kind === "deployToken") return actor.token.kind === "user" ? actor.token.userId : null;
  return actor.userId;
}

// Roles on the deploy path (lib/permissions.ts). `target` is the app the
// deploy would land on, or null when it would add one to the workspace (see
// projectClaim.ts peekDeployTarget). Null back means go ahead; otherwise the
// status + body to answer with, which hostnsoft-deploy relays to the agent.
//
// Dashboard uploads only: the signed-in person's role decides. Deploy tokens
// are decided in resolveDeployTarget (services/tokenAccess.ts): a workspace
// token acts as its workspace, so it keeps working after the person who
// made it leaves (CI); a user token acts as its person through can(), so it
// stops when they lose access.
//
// An app the person can't see gets the same permission_denied as one they
// can see but not deploy, not the usual 404: the deploy would otherwise go on
// to answer "already in use by a different workspace" or, worse, look like a
// new name — and the name is already public, it's the app's address.
export async function authorizeDeploy(
  actor: DeployActor,
  target: Pick<Project, "id" | "createdBy"> | null
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  if (actor.kind !== "proxyAuth") return null;

  // Membership was just verified by resolveDeployActor, so this can only be
  // null if they left in between — the same answer as a non-member.
  const access = await resolveAccess(actor.userId, actor.companyId, { membershipChecked: true });
  if (!access) return { status: 403, body: { error: "You're not a member of this workspace.", code: "not_a_company_member" } };

  const permission = target ? "app.deploy" : "app.create";
  if (!accessAllows(access, permission, target ?? undefined)) {
    return { status: 403, body: permissionDeniedBody(permission, access, target ?? undefined) };
  }
  return null;
}
