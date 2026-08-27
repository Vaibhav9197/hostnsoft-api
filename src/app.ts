import "express-async-errors";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { router } from "./routes";
import { errorHandler } from "./middleware/errorHandler";
import { FRONTEND_ORIGIN } from "./lib/frontendOrigin";

export function createApp() {
  const app = express();

  app.use(helmet());
  // credentials: true + an explicit origin (not "*") is required for the
  // httpOnly refresh-token cookie in src/routes/auth.routes.ts to work
  // cross-origin from the dashboard frontend.
  app.use(
    cors({
      origin: FRONTEND_ORIGIN,
      credentials: true,
    })
  );
  app.use(express.json());
  app.use(cookieParser());
  app.use(router);
  app.use(errorHandler);

  return app;
}
