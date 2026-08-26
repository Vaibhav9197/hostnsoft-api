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

const exchangeSchema = z.object({ token: z.string().min(1) });

// Token-exchange flow (docs/msg91-proxy-auth.md, "Option B"). The client
// embeds the MSG91 widget and gets back a proxy_auth_token; it sends that
// token here. This is the ONLY thing that establishes trust — the token
// is verified against MSG91 before any local user is created or session
// issued. If the identity carries a currentCompany, it IS a hostnsoft
// Company (see src/services/msg91Login.ts) — not a separate entity linked
// to one.
authRouter.post("/auth/msg91/exchange", async (req, res) => {
  const { token } = exchangeSchema.parse(req.body);

  let identity;
  try {
    identity = await verifyProxyAuthToken(token);
  } catch (err) {
    if (err instanceof Msg91AuthError) {
      return res.status(401).json({ error: "Authentication failed" });
    }
    throw err;
  }

  const user = await findOrCreateUserFromMsg91(identity);
  const { accessToken, refreshToken } = await issueSession(user.id);
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
