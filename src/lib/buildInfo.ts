/**
 * Which code this process is running, read once at startup and reported by
 * GET /health. The deploy workflow (.github/workflows/deploy-prod.yml)
 * compares `commit` with the pushed commit, so a reload that failed and
 * left the old process serving shows up as a failed deploy instead of
 * passing silently.
 *
 * Read at startup on purpose: `git rev-parse` at request time would report
 * whatever was pulled onto disk, not what is loaded in memory.
 */
import { execFileSync } from "node:child_process";

function readCommit(): string {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    // Any folder inside the checkout works, dist/ included.
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

export const BUILD_INFO = {
  commit: readCommit(),
  startedAt: new Date().toISOString(),
};
