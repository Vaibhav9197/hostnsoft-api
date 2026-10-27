/**
 * The invite link's preview, readable signed out — the join page shows it
 * before asking someone to sign in. Only what previewLink returns (the
 * workspace's name, who made the link, the role and the rule), and the same
 * plain 404 for every code that doesn't work, so a bad or old link says
 * nothing about any workspace. Joining itself needs sign-in:
 * routes/members.routes.ts.
 */
import { Router } from "express";
import { previewLink } from "../services/inviteLinks";

export const publicInviteLinksRouter = Router();

publicInviteLinksRouter.get("/invite-links/:code", async (req, res) => {
  const preview = await previewLink(req.params.code);
  if (!preview) return res.status(404).json({ error: "This invite link doesn't work.", code: "invalid_link" });
  res.set("Cache-Control", "no-store").json(preview);
});
