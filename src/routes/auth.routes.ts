import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { signAccessToken } from "../lib/jwt";
import {
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_TTL_MS,
  generateRefreshToken,
  hashRefreshToken,
} from "../lib/refreshTokens";
import { verifyProxyAuthToken, Msg91AuthError } from "../lib/msg91";
import { findOrCreateUserFromMsg91 } from "../services/msg91Login";
import { requireAuth } from "../middleware/auth";
import { FRONTEND_ORIGIN } from "../lib/frontendOrigin";
import { logger } from "../lib/logger";

export const authRouter = Router();

// The agent never logs in as the person and never holds a dashboard
// session — it only needs a Deploy Token, bootstrapped manually through
// this dashboard once (see docs/CLAUDE.md "Auth flow" #2). Everything
// below is the *human* login path only.

async function issueSession(userId: string) {
  const accessToken = signAccessToken(userId);
  const { token: refreshToken, tokenHash } = generateRefreshToken();

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  });

  return { accessToken, refreshToken };
}

function setRefreshCookie(res: import("express").Response, refreshToken: string) {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
}

// Shared by both msg91 flows below (POST exchange and GET callback) — the
// only difference between them is how the caller learns the result (JSON
// body vs. a browser redirect), not how a token gets turned into a
// session. Throws Msg91AuthError if MSG91 rejects the token; anything
// else is a real server error and propagates as-is.
async function loginWithMsg91Token(token: string) {
  const identity = await verifyProxyAuthToken(token);
  const user = await findOrCreateUserFromMsg91(identity);
  const session = await issueSession(user.id);
  return { user, ...session };
}

const exchangeSchema = z.object({ token: z.string().min(1) });

// Token-exchange flow (docs/msg91-proxy-auth.md, "Option B" — token
// exchange, best for pure API/SPA clients). The client embeds the MSG91
// widget and gets the token back directly in its `success` callback; it
// POSTs that token here itself, in-page, no navigation involved.
authRouter.post("/auth/msg91/exchange", async (req, res) => {
  const { token } = exchangeSchema.parse(req.body);

  let result;
  try {
    result = await loginWithMsg91Token(token);
  } catch (err) {
    if (err instanceof Msg91AuthError) {
      logger.warn(`[auth.msg91.exchange] rejected: ${err.message}`);
      return res.status(401).json({ error: "Authentication failed" });
    }
    throw err;
  }

  const { user, accessToken, refreshToken } = result;
  setRefreshCookie(res, refreshToken);

  const memberships = await prisma.companyMembership.findMany({
    where: { userId: user.id },
    include: { company: true },
  });

  res.json({
    user: { id: user.id, email: user.email, name: user.name },
    token: accessToken,
    companies: memberships.map((m) => ({
      companyId: m.companyId,
      companyName: m.company.name,
      role: m.role,
    })),
  });
});

// Only allows a same-origin-relative path, never letting the query string
// dictate the redirect's origin — the classic open-redirect vector, and
// exactly what docs/msg91-proxy-auth.md's security notes call out
// ("restrict redirect targets to an allowlist if you use the redirect
// flow"). The allowlist here is simply "must be a path on FRONTEND_ORIGIN,
// full stop" — the origin itself is never taken from the request.
const DEFAULT_REDIRECT_PATH = "/";
function safeRedirectPath(next: unknown): string {
  if (typeof next !== "string" || next.length === 0) return DEFAULT_REDIRECT_PATH;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("://")) {
    return DEFAULT_REDIRECT_PATH;
  }
  return next;
}

// Redirect flow (docs/msg91-proxy-auth.md, "Option A" — callback flow,
// for browser-based apps that configure the widget's `addInfo.redirect_path`
// to point here instead of handling the token in-page). MSG91 sends the
// user's browser here directly with `?proxy_auth_token=...` (plus
// whatever else was already on the configured redirect_path, e.g.
// `?next=/dashboard`) — there is no JSON response to read here, only a
// redirect, since nothing in-page ever gets to inspect this response.
//
// Session is still established server-side exactly like the POST flow
// (the refresh cookie is set on this redirect response, same as any
// other auth response) — the frontend lands on `next` already logged in,
// and should call POST /auth/refresh on load to mint an access token
// from that cookie rather than expecting one in the URL (an access token
// in a redirect URL would end up in browser history and server logs).
authRouter.get("/auth/msg91/callback", async (req, res) => {
  const next = safeRedirectPath(req.query.next);
  const token = req.query.proxy_auth_token;

  if (typeof token !== "string" || token.length === 0) {
    return res.redirect(`${FRONTEND_ORIGIN}${next}?auth_error=missing_token`);
  }

  let result;
  try {
    result = await loginWithMsg91Token(token);
  } catch (err) {
    if (err instanceof Msg91AuthError) {
      logger.warn(`[auth.msg91.callback] rejected: ${err.message}`);
      return res.redirect(`${FRONTEND_ORIGIN}${next}?auth_error=invalid_token`);
    }
    throw err;
  }

  setRefreshCookie(res, result.refreshToken);
  res.redirect(`${FRONTEND_ORIGIN}${next}`);
});

authRouter.post("/auth/refresh", async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!raw) return res.status(401).json({ error: "Missing refresh token" });

  const tokenHash = hashRefreshToken(raw);
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (
    !existing ||
    existing.revokedAt ||
    existing.expiresAt.getTime() < Date.now()
  ) {
    return res.status(401).json({ error: "Invalid or expired refresh token" });
  }

  // Rotate on every use — the old refresh token is single-use.
  await prisma.refreshToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });

  const { accessToken, refreshToken } = await issueSession(existing.userId);
  setRefreshCookie(res, refreshToken);
  res.json({ accessToken });
});

authRouter.post("/auth/logout", async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE_NAME];
  if (raw) {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hashRefreshToken(raw), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  res.clearCookie(REFRESH_COOKIE_NAME);
  res.status(204).end();
});

authRouter.get("/auth/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    include: { memberships: { include: { company: true } } },
  });

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    companies: user.memberships.map((m) => ({
      companyId: m.companyId,
      companyName: m.company.name,
      role: m.role,
      status: m.status,
    })),
  });
});
