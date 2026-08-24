/**
 * Replaces `@/lib/redis` for database tests (see `moduleNameMapper` in
 * `jest.db.config.ts`).
 *
 * The real module constructs an ioredis client at import time from
 * `UPSTASH_REDIS_URL`. In this repository that value currently points at a
 * hosted Redis, so importing the app in a test would open a socket to a live
 * instance. Prisma is real in these tests; Redis deliberately is not.
 */

type Handler = (...args: unknown[]) => void;

export const redisConnection = {
  on(_event: string, _handler: Handler) {
    return this;
  },
  off(_event: string, _handler: Handler) {
    return this;
  },
  async ping() {
    return 'PONG';
  },
  async quit() {
    return 'OK';
  },
  disconnect() {
    /* no-op */
  },
  status: 'ready',
};
