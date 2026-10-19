import { Router } from "express";
import { BUILD_INFO } from "../lib/buildInfo";

export const healthRouter = Router();

// `commit` and `startedAt` say which code is serving and since when — see
// lib/buildInfo.ts. `status` keeps its old value for existing checks.
healthRouter.get("/health", (_req, res) => {
  res.json({ status: "ok v1", commit: BUILD_INFO.commit, startedAt: BUILD_INFO.startedAt });
});
