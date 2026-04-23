import IORedis from 'ioredis';
import { env } from '@/config/env';
import { createLogger } from '@/lib/logger';

const log = createLogger('redis');

const redisConfig = env.UPSTASH_REDIS_URL
  ? env.UPSTASH_REDIS_URL
  : {
      host: env.REDIS_HOST!,
      port: env.REDIS_PORT!,
      password: env.REDIS_PASSWORD!,
      tls: env.REDIS_TLS ? {} : undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy: (times: number) => {
        if (times > 10) {
          log.error('Redis connection failed after 10 retries');
          return null;
        }
        return Math.min(times * 200, 3000);
      },
    };

export const redisConnection = new IORedis(redisConfig);

redisConnection.on('connect', () => log.info('Redis connected'));
redisConnection.on('close', () => log.warn('Redis connection closed'));
redisConnection.on('error', (err) => log.error('Redis error', { error: err.message }));