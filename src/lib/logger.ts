/**
 * Every log line in this service goes through here so they all share one
 * shape: `<ISO timestamp> <request id>: <message>`. The request id comes
 * from AsyncLocalStorage (see requestContext.ts) so every log made while
 * handling a request — including deep inside services — is tagged with
 * it automatically, without passing it around explicitly. Logs made
 * outside any request (startup, fatal env-var checks) get "-" instead.
 */
import { getRequestId } from "./requestContext";

type LogArgs = unknown[];

function write(level: "info" | "warn" | "error", args: LogArgs): void {
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  const requestId = getRequestId() ?? "-";
  fn(`${new Date().toISOString()} ${requestId}:`, ...args);
}

export const logger = {
  info: (...args: LogArgs) => write("info", args),
  warn: (...args: LogArgs) => write("warn", args),
  error: (...args: LogArgs) => write("error", args),
};
