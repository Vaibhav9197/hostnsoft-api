import jwt from "jsonwebtoken";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is not set.");
}
const JWT_SECRET: string = process.env.JWT_SECRET;

// Short-lived — the dashboard is expected to hold this in memory and
// renew it via POST /auth/refresh, not persist it. See docs/CLAUDE.md
// "Auth flow" #1.
export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: "15m" });
}

export function verifyAccessToken(token: string): { userId: string } {
  const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
  return { userId: payload.sub as string };
}
