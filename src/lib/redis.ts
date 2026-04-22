import IORedis from 'ioredis';
import { env } from '@/config/env';
import { createLogger } from '@/lib/logger';

const log = createLogger('redis');

const redisConfig = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
  tls: env.REDIS_TLS ? {} : undefined,
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false,    // Required by BullMQ with Upstash
  retryStrategy: (times: number) => {
    if (times > 10) {
      log.error('Redis connection failed after 10 retries');
      return null;
    }
    return Math.min(times * 200, 3000);
  },
};

// BullMQ connection — shared across all queues and workers
export const redisConnection = new IORedis(redisConfig);

redisConnection.on('connect', () => log.info('Redis connected'));
redisConnection.on('error', (err) => log.error('Redis error', { error: err.message }));
redisConnection.on('close', () => log.warn('Redis connection closed'));
