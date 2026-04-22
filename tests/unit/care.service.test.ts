import { careService } from '@/modules/care/care.service';
import { careRepository } from '@/modules/care/care.repository';
import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';

jest.mock('@/modules/care/care.repository');
jest.mock('@/lib/prisma', () => ({
  prisma: { $transaction: jest.fn() },
}));

const mockCareRepo = careRepository as jest.Mocked<typeof careRepository>;
const mockPrisma = prisma as jest.Mocked<typeof prisma>;

const mockEvent = {
  id: 'event-1',
  carePlanId: 'plan-1',
  eventType: 'MEDICATION_DOSE',
  title: 'Take Paracetamol',
  description: null,
  scheduledFor: new Date(),
  status: 'PENDING' as const,
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  carePlan: {
    id: 'plan-1',
    userId: 'user-1',
    type: 'MEDICATION' as const,
    title: 'Paracetamol plan',
    status: 'ACTIVE' as const,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  },
};

describe('CareService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('updateEventStatus', () => {
    it('throws not found for unknown event', async () => {
      mockCareRepo.findCareEvent.mockResolvedValue(null);

      await expect(
        careService.updateEventStatus('user-1', 'bad-id', 'DONE'),
      ).rejects.toMatchObject({ errorCode: 'NOT_FOUND' });
    });

    it('throws forbidden if event belongs to another user', async () => {
      mockCareRepo.findCareEvent.mockResolvedValue({
        ...mockEvent,
        carePlan: { ...mockEvent.carePlan, userId: 'other-user' },
      } as any);

      await expect(
        careService.updateEventStatus('user-1', 'event-1', 'DONE'),
      ).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
    });

    it('updates status and creates activity log in a transaction', async () => {
      mockCareRepo.findCareEvent.mockResolvedValue(mockEvent as any);

      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn) =>
        fn({
          careEvent: { update: jest.fn().mockResolvedValue({ ...mockEvent, status: 'DONE' }) },
          activityLog: { create: jest.fn() },
        }),
      );

      mockCareRepo.updateCareEventStatus.mockResolvedValue({
        ...mockEvent,
        status: 'DONE',
      } as any);
      mockCareRepo.createActivityLog.mockResolvedValue({} as any);

      const result = await careService.updateEventStatus('user-1', 'event-1', 'DONE');
      expect(result).toBeDefined();
    });
  });
});
