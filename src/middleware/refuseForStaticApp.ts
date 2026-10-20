import type { NextFunction, Request, Response } from "express";

// The agent guide's topic on static sites: what they can't do, and why.
const STATIC_SITES_HELP = "https://embarko.ai/docs/static-sites";

// A static site (Project.kind "static") is served straight from its files:
// no process runs, so nothing reads env vars and there is no memory to
// size. Writes used to be accepted and silently reached nothing — refused
// here instead, so an agent or a person learns that immediately rather
// than after debugging an app that "ignores" its config.
//
// Only writes go through this. Reading or deleting stays allowed: an app
// converted from a server app may still hold variables from before, and
// removing them is harmless.
const WHAT = {
  env_vars: "Env vars don't apply",
  memory: "Memory can't be set",
  schedules: "Schedules can't run",
} as const;

const NEXT = {
  env_vars: "Put the config in the site's files instead, or deploy it as a server app under a new name (see links.help).",
  memory: "Static sites need no memory setting; to run server code, deploy it as a server app under a new name (see links.help).",
  schedules: "A schedule calls a route in the app's server code; deploy it as a server app under a new name (see links.help).",
} as const;

export function refuseForStaticApp(feature: keyof typeof WHAT) {
  return (req: Request, res: Response, next: NextFunction) => {
    const project = req.project;
    if (!project || project.kind !== "static") return next();

    res.status(409).json({
      error: `"${project.slug}" is a static site. ${WHAT[feature]}: nothing runs on the server.`,
      code: "not_supported_for_static",
      next: NEXT[feature],
      links: { help: STATIC_SITES_HELP },
    });
  };
}
