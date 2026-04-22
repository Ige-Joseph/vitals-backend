import { PrismaClient } from '@prisma/client';
import { env } from '@/config/env';
import { createLogger } from '@/lib/logger';

const log = createLogger('prisma');

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Prisma 6 — $on() for query/error events requires emit: 'event' in the log config.
// The (prisma as any) cast is used because TypeScript types for $on are
// only available after prisma generate runs against a real schema.
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      env.NODE_ENV === 'development'
        ? [
            { emit: 'event', level: 'query' },
            { emit: 'event', level: 'error' },
            { emit: 'event', level: 'warn' },
          ]
        : [{ emit: 'event', level: 'error' }],
  });

if (env.NODE_ENV === 'development') {
  (prisma as any).$on('query', (e: any) => {
    log.debug('Query', { query: e.query, duration: `${e.duration}ms` });
  });
}

(prisma as any).$on('error', (e: any) => {
  log.error('Prisma error', { message: e.message, target: e.target });
});

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
