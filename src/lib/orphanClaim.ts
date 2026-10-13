/**
 * The claim code behind an orphan's claim link — see
 * docs/Anonymous-deploy-req.md ("Claim link", 2026-10-08).
 *
 * An anonymous deploy stores no owner, so until now the only proof of
 * "I deployed this" was redeploying the same name with a token — which
 * needs the source and an agent session, and which anyone holding a token
 * could do first. The claim code is that missing proof: 32 random bytes
 * minted once, when the orphan is first created, returned once in that
 * deploy's response (inside a link to the dashboard), and kept here only
 * as a SHA-256 hash, exactly like a deploy token (lib/deployTokens.ts).
 *
 * Deliberately not the deployment id: a cuid is built from a timestamp
 * and a counter, shows up in status replies and logs that need no
 * credential, changes on every anonymous redeploy, and may be missing
 * altogether when the best-effort record call failed.
 */
import crypto from "crypto";
import { FRONTEND_ORIGIN } from "./frontendOrigin";

// base64url rather than hex: half the length in a link someone may read
// out or paste, with the same 256 bits of entropy.
export function generateClaimCode(): { code: string; hash: string } {
  const code = crypto.randomBytes(32).toString("base64url");
  return { code, hash: hashClaimCode(code) };
}

export function hashClaimCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

// Constant-time, so a wrong code costs the same as a right one. Both sides
// are hex digests of equal length, which timingSafeEqual requires.
export function claimCodeMatches(code: string, storedHash: string | null | undefined): boolean {
  if (!storedHash) return false;
  const a = Buffer.from(hashClaimCode(code), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The link the deployer opens: the dashboard's /claim page, which signs
// them in (or up) and then calls POST /companies/:companyId/orphans/claim
// with these two values. The app name travels in the link too so the page
// can show "Keep <app>" before anyone is signed in.
export function buildClaimUrl(slug: string, code: string): string {
  const url = new URL("/claim", FRONTEND_ORIGIN);
  url.searchParams.set("app", slug);
  url.searchParams.set("code", code);
  return url.toString();
}
