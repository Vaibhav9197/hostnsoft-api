import { Router } from "express";

export const publicDocsRouter = Router();

// The customer-facing docs used to be authored in this repo, under
// public-docs/, and served from here as both HTML and raw markdown. They now
// are the agent guide on the website (embarko.ai/docs, built in the site
// repo), so embarko.ai is the only place they exist.
//
// Two copies of the same documentation is how they drift, and they did: this
// repo kept serving a description of a synchronous deploy API for some time
// after the deploy endpoint went async.
//
// What stays here is the redirects. The old URLs are in published skill
// assets, in the capabilities manifest, and in whatever else already copied
// them down, so they must keep resolving — they just resolve somewhere else
// now. 301, because this move is permanent.
const DOC_DESTINATIONS: Record<string, string> = {
  index: "https://embarko.ai/docs",
  docs: "https://embarko.ai/docs",
  // Straight to the guide topic that replaced each page, not via the site's
  // own redirects for the old addresses.
  troubleshoot: "https://embarko.ai/docs/errors",
  "limitations-and-recommendations": "https://embarko.ai/docs/prerequisites",
  hackathons: "https://embarko.ai/hackathons",
};

// An allowlist rather than a catch-all on /public/:slug. This router is
// mounted alongside the other /public endpoints (deploy-token requests,
// customer queries), and a greedy pattern here would swallow any of them that
// happen to be a single path segment.
for (const [slug, destination] of Object.entries(DOC_DESTINATIONS)) {
  publicDocsRouter.get(`/public/${slug}`, (_req, res) => res.redirect(301, destination));
  publicDocsRouter.get(`/public/${slug}.md`, (_req, res) => res.redirect(301, destination));
}
