const processors: Array<(job: any) => Promise<void>> = [];

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_name: string, processor: (job: any) => Promise<void>) => {
    processors.push(processor);
    return { on: jest.fn() };
  }),
}));

jest.mock('@/lib/redis', () => ({ redisConnection: {} }));
jest.mock('@/queues/queue.registry', () => ({
  QUEUE_NAMES: { ADHERENCE: 'adherence' },
  JOB_NAMES: { CHECK_MEDICATION_ADHERENCE: 'CHECK_MEDICATION_ADHERENCE' },
}));
jest.mock('@/modules/care/adherence.service', () => ({
  processAdherenceCheck: jest.fn(),
}));

import { processAdherenceCheck } from '@/modules/care/adherence.service';
import { adherenceWorker } from '@/workers/adherence.worker';

void adherenceWorker;
const mockProcess = processAdherenceCheck as jest.MockedFunction<typeof processAdherenceCheck>;

beforeEach(() => {
  jest.clearAllMocks();
});

it('passes the reminderId from an old payload shape to the shared service', async () => {
  await processors[0]({
    id: 'job-1',
    name: 'CHECK_MEDICATION_ADHERENCE',
    data: {
      reminderId: 'rem-1',
      careEventId: 'legacy-event',
      personId: 'legacy-person',
      medicationName: 'Legacy medication',
      scheduledFor: '2026-09-19T08:00:00.000Z',
    },
  });

  expect(mockProcess).toHaveBeenCalledWith('rem-1');
});
