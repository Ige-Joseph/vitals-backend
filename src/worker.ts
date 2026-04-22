import '@/config/env'; // Validate env before anything else
import { notificationsWorker } from '@/workers/notifications.worker';
import { adherenceWorker } from '@/workers/adherence.worker';
import {
  reminderSchedulerWorker,
  reminderSchedulerQueue,
  startScheduledJobs,
} from '@/jobs/reminder.job';
import { redisConnection } from '@/lib/redis';
import { prisma } from '@/lib/prisma';
import { initFirebase } from '@/lib/firebase';
import { createLogger } from '@/lib/logger';

const log = createLogger('worker');

const start = async () => {
  // Initialise Firebase Admin — the reminder engine needs it to send FCM push notifications.
  // No-op if Firebase env vars are not set.
  initFirebase();

  try {
    await prisma.$connect();
    log.info('Worker process: database connected');
  } catch (err: any) {
    log.error('Worker failed to connect to database', { error: err.message });
    process.exit(1);
  }

  await startScheduledJobs();

  log.info('Worker process started', {
    workers: ['notifications', 'adherence', 'reminder-scheduler'],
  });

  const shutdown = async (signal: string) => {
    log.info(`${signal} received — shutting down workers`);

    try {
      await notificationsWorker.close();
      await adherenceWorker.close();
      await reminderSchedulerWorker.close();
      await reminderSchedulerQueue.close();
      log.info('Workers closed');

      await prisma.$disconnect();
      redisConnection.disconnect();
      log.info('Connections closed');

      process.exit(0);
    } catch (err: any) {
      log.error('Error during worker shutdown', { error: err.message });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception in worker', { error: err.message, stack: err.stack });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection in worker', { reason });
    process.exit(1);
  });
};

start();
