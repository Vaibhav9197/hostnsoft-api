import type { NextFunction, Request, Response } from "express";

// A static site (Project.kind "static") is served straight from its files:
// no process runs, so nothing reads env vars and there is no memory to
// size. Writes used to be accepted and silently reached nothing — refused
// here instead, so an agent or a person learns that immediately rather
// than after debugging an app that "ignores" its config.
//
// Only writes go through this. Reading or deleting stays allowed: an app
// converted from a server app may still hold variables from before, and
// removing them is harmless.
export function refuseForStaticApp(feature: "env_vars" | "memory") {
  return (req: Request, res: Response, next: NextFunction) => {
    const project = req.project;
    if (!project || project.kind !== "static") return next();

    const what = feature === "env_vars" ? "Env vars don't apply" : "Memory can't be set";
    res.status(409).json({
      error: `"${project.slug}" is a static site. ${what}: nothing runs on the server.`,
      code: "not_supported_for_static",
      next:
        feature === "env_vars"
          ? "If the site needs configuration, put it in the files (for example a config.js), or deploy it as a server app under a new app name."
          : "A static site needs no memory setting. To run server code, deploy it as a server app under a new app name.",
    });
  };
}
