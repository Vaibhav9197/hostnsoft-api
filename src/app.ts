import "express-async-errors";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { router } from "./routes";
import { errorHandler } from "./middleware/errorHandler";
import { requestLogger } from "./middleware/requestLogger";
import { FRONTEND_ORIGIN } from "./lib/frontendOrigin";

export function createApp() {
  const app = express();

  // First, ahead of everything else — every log line for the rest of this
  // request's lifecycle (including inside helmet/cors failures and the
  // final error handler) needs the request id already in context.
  app.use(requestLogger);
  app.use(helmet());
  app.use(
    cors({
      origin: FRONTEND_ORIGIN,
      credentials: true,
    })
  );
  app.use(express.json());
  // app.use(cookieParser());
  app.use(router);
  app.use(errorHandler);

  return app;
}
