// Redis-backed TTL cache for proxy lookups, shared across processes.
// `getOrLoad` de-dupes concurrent misses within this process; the ttl
// callback lets callers return 0 to skip caching (used for negative
// membership answers, so a removed member isn't cached as "not a member").
import { redis } from "./redis";
import { logger } from "./logger";

export class TtlCache<V> {
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(private readonly prefix: string, private readonly defaultTtlMs: number) {}

  private key(key: string): string {
    return `hostnsoft-api:${this.prefix}:${key}`;
  }

  async get(key: string): Promise<V | undefined> {
    const raw = await redis.get(this.key(key)).catch((err) => {
      logger.error(`[ttlCache:${this.prefix}] get failed:`, err);
      return null;
    });
    return raw === null ? undefined : (JSON.parse(raw) as V);
  }

  async delete(key: string): Promise<void> {
    await redis.del(this.key(key)).catch((err) => {
      logger.error(`[ttlCache:${this.prefix}] delete failed:`, err);
    });
  }

  async getOrLoad(
    key: string,
    loader: () => Promise<V>,
    ttlMs: (value: V) => number = () => this.defaultTtlMs
  ): Promise<V> {
    const cached = await this.get(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = loader()
      .then(async (value) => {
        const ttl = ttlMs(value);
        if (ttl > 0) {
          await redis
            .set(this.key(key), JSON.stringify(value), { PX: ttl })
            .catch((err) => logger.error(`[ttlCache:${this.prefix}] set failed:`, err));
        }
        return value;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, promise);
    return promise;
  }
}
