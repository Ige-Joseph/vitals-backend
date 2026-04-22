import { Request, Response } from 'express';
import { prisma } from '@/lib/prisma';
import { redisConnection } from '@/lib/redis';
import { ok, sendError } from '@/lib/response';

export const healthController = {
  async check(_req: Request, res: Response) {
    const checks = {
      api: 'ok' as 'ok' | 'error',
      database: 'ok' as 'ok' | 'error',
      redis: 'ok' as 'ok' | 'error',
    };

    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      checks.database = 'error';
    }

    try {
      await redisConnection.ping();
    } catch {
      checks.redis = 'error';
    }

    const isHealthy = Object.values(checks).every((v) => v === 'ok');

    if (!isHealthy) {
      sendError(res, 'Service unhealthy', 'INTERNAL_ERROR', 503);
      return;
    }

    ok(res, { status: 'healthy', checks, timestamp: new Date().toISOString() }, 'Healthy');
  },
};
