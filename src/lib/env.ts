// Numeric env var with a default. Throws on garbage rather than letting NaN
// leak into timers and limits.
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number, got "${raw}".`);
  }
  return n;
}
