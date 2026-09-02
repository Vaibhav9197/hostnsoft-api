/**
 * Every log line in this service goes through here so they all share one
 * shape: `[<ISO timestamp>] [<LEVEL>] <message>`. Before this, call sites
 * used raw console.log/warn/error inconsistently, with no timestamp —
 * made it hard to correlate a log line with a specific request or tell
 * how stale a line in a scrollback was.
 */
type LogArgs = unknown[];

function write(level: "info" | "warn" | "error", args: LogArgs): void {
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(`[${new Date().toISOString()}] [${level.toUpperCase()}]`, ...args);
}

export const logger = {
  info: (...args: LogArgs) => write("info", args),
  warn: (...args: LogArgs) => write("warn", args),
  error: (...args: LogArgs) => write("error", args),
};
