import { createApp } from './app';
import { env } from '@/config/env';
import { prisma } from '@/lib/prisma';
import { redisConnection } from '@/lib/redis';
import { closeQueues } from '@/queues/queue.registry';
import { initFirebase } from '@/lib/firebase';
import { createLogger } from '@/lib/logger';

const log = createLogger('server');

const HOST = '0.0.0.0';

const start = async () => {
  initFirebase();

  try {
    await prisma.$connect();
    log.info('Database connected');
  } catch (err: any) {
    log.error('Failed to connect to database', { error: err.message });
    process.exit(1);
  }

  const app = createApp();

  const server = app.listen(env.PORT, HOST, () => {
    log.info('Server running', {
      host: HOST,
      port: env.PORT,
      env: env.NODE_ENV,
      prefix: env.API_PREFIX,
    });
  });

  const shutdown = async (signal: string) => {
    log.info(`${signal} received — shutting down gracefully`);

    server.close(async () => {
      log.info('HTTP server closed');

      try {
        await closeQueues();
        log.info('BullMQ queues closed');

        await prisma.$disconnect();
        log.info('Database disconnected');

        redisConnection.disconnect();
        log.info('Redis disconnected');

        process.exit(0);
      } catch (err: any) {
        log.error('Error during shutdown', { error: err.message });
        process.exit(1);
      }
    });

    setTimeout(() => {
      log.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', { error: err.message, stack: err.stack });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', { reason });
    process.exit(1);
  });
};

start();