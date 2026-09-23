jest.mock('@/lib/prisma', () => ({ prisma: {} }));
jest.mock('@/modules/care/recipient.resolver', () => ({ recipientResolver: {} }));
jest.mock('@/modules/outbox/outbox.repository', () => ({ outboxRepository: {} }));
jest.mock('@/modules/care/care.repository', () => ({ careRepository: {} }));
jest.mock('@/queues/queue.registry', () => ({
  adherenceQueue: {},
  JOB_NAMES: { CHECK_MEDICATION_ADHERENCE: 'CHECK_MEDICATION_ADHERENCE' },
}));

import { Queue, QueueEvents, Worker } from 'bullmq';
import { enqueueDueAdherenceCheck } from '@/modules/care/adherence.service';

const connection = {
  host: '127.0.0.1',
  port: Number(process.env.STAGE2_REDIS_PORT ?? 6381),
  maxRetriesPerRequest: null,
};

const waitForState = async (job: { getState: () => Promise<string> }, state: string) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await job.getState()) === state) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for Redis job state ${state}`);
};

describe('adherence recovery against disposable Redis', () => {
  const queueName = `stage2-adherence-${process.pid}`;
  let queue: Queue;
  let events: QueueEvents;
  let worker: Worker;

  beforeAll(async () => {
    queue = new Queue(queueName, {
      connection,
      defaultJobOptions: { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } },
    });
    events = new QueueEvents(queueName, { connection });
    worker = new Worker(queueName, async () => undefined, { connection });
    await Promise.all([queue.waitUntilReady(), events.waitUntilReady(), worker.waitUntilReady()]);
  });

  afterAll(async () => {
    await worker.close();
    await events.close();
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('retained completed jobs make queue.add a no-op, then remove-and-add repairs it', async () => {
    const jobId = 'adherence-retained';
    const first = await queue.add('CHECK_MEDICATION_ADHERENCE', { reminderId: 'retained' }, { jobId });
    await first.waitUntilFinished(events, 5000);

    const retained = await queue.getJob(jobId);
    expect(retained).toBeDefined();
    expect(await retained!.getState()).toBe('completed');

    const duplicate = await queue.add(
      'CHECK_MEDICATION_ADHERENCE',
      { reminderId: 'retained-duplicate' },
      { jobId },
    );
    expect(duplicate.id).toBe(jobId);
    expect((await queue.getJob(jobId))!.data.reminderId).toBe('retained');

    const result = await enqueueDueAdherenceCheck(queue, 'retained');
    expect(result).toBe('enqueued');
    const repaired = await queue.getJob(jobId);
    expect(repaired).toBeDefined();
    await repaired!.waitUntilFinished(events, 5000);
  });

  it('skips waiting and delayed jobs without adding duplicates', async () => {
    const idleQueue = new Queue(`${queueName}-idle`, { connection });
    await idleQueue.waitUntilReady();

    const waitingId = 'adherence-waiting';
    await idleQueue.add(
      'CHECK_MEDICATION_ADHERENCE',
      { reminderId: waitingId },
      { jobId: waitingId },
    );
    await expect(enqueueDueAdherenceCheck(idleQueue, 'waiting')).resolves.toBe('skipped');

    const delayedId = 'adherence-delayed';
    await idleQueue.add(
      'CHECK_MEDICATION_ADHERENCE',
      { reminderId: delayedId },
      { jobId: delayedId, delay: 60_000 },
    );
    await expect(enqueueDueAdherenceCheck(idleQueue, 'delayed')).resolves.toBe('skipped');

    await idleQueue.obliterate({ force: true });
    await idleQueue.close();
  });

  it('skips an active job without removing it', async () => {
    const activeQueueName = `${queueName}-active`;
    const activeQueue = new Queue(activeQueueName, { connection });
    const gate = new Promise<void>((resolve) => {
      const activeWorker = new Worker(
        activeQueueName,
        async () => {
          await gate;
        },
        { connection },
      );
      void activeWorker;
      (globalThis as any).__stage2ActiveWorker = activeWorker;
      (globalThis as any).__stage2ReleaseActive = resolve;
    });

    const jobId = 'adherence-active';
    await activeQueue.add('CHECK_MEDICATION_ADHERENCE', { reminderId: 'active' }, { jobId });
    const activeJob = await activeQueue.getJob(jobId);
    await waitForState(activeJob!, 'active');

    await expect(enqueueDueAdherenceCheck(activeQueue, 'active')).resolves.toBe('skipped');
    expect(await activeQueue.getJob(jobId)).toBeDefined();

    (globalThis as any).__stage2ReleaseActive();
    await gate;
    await (globalThis as any).__stage2ActiveWorker.close();
    await activeQueue.obliterate({ force: true });
    await activeQueue.close();
  });
});
