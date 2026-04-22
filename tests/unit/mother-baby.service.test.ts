import { motherBabyService } from '@/modules/mother-baby/mother-baby.service';
import { motherBabyRepository } from '@/modules/mother-baby/mother-baby.repository';
import { careRepository } from '@/modules/care/care.repository';
import { careService } from '@/modules/care/care.service';
import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';

jest.mock('@/modules/mother-baby/mother-baby.repository');
jest.mock('@/modules/care/care.repository');
jest.mock('@/modules/care/care.service');
jest.mock('@/lib/prisma', () => ({
  prisma: { $transaction: jest.fn() },
}));

const mockMotherBabyRepo = motherBabyRepository as jest.Mocked<typeof motherBabyRepository>;
const mockCareRepo = careRepository as jest.Mocked<typeof careRepository>;
const mockCareService = careService as jest.Mocked<typeof careService>;
const mockPrisma = prisma as jest.Mocked<typeof prisma>;

const mockCarePlan = {
  id: 'plan-1',
  userId: 'user-1',
  type: 'PREGNANCY' as const,
  title: 'Pregnancy plan',
  status: 'ACTIVE' as const,
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('MotherBabyService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('setupPregnancy', () => {
    it('throws conflict if active pregnancy exists', async () => {
      mockMotherBabyRepo.findActivePregnancy.mockResolvedValue({
        id: 'existing',
        carePlanId: 'plan-1',
        carePlan: mockCarePlan,
      } as any);

      await expect(
        motherBabyService.setupPregnancy('user-1', { lmpDate: '2024-01-01' }),
      ).rejects.toMatchObject({ errorCode: 'CONFLICT' });
    });

    it('throws bad request if neither lmpDate nor pregnancyWeekAtSetup provided', async () => {
      mockMotherBabyRepo.findActivePregnancy.mockResolvedValue(null);

      await expect(
        motherBabyService.setupPregnancy('user-1', {}),
      ).rejects.toMatchObject({ errorCode: 'BAD_REQUEST' });
    });

    it('creates pregnancy plan via transaction with valid lmpDate', async () => {
      mockMotherBabyRepo.findActivePregnancy.mockResolvedValue(null);

      const mockProfile = {
        id: 'profile-1',
        carePlanId: 'plan-1',
        lmpDate: new Date('2024-01-01'),
        pregnancyWeekAtSetup: 10,
        currentWeek: 10,
        trimester: 1,
        expectedDeliveryDate: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn) =>
        fn({
          carePlan: { create: jest.fn().mockResolvedValue(mockCarePlan) },
          pregnancyProfile: { create: jest.fn().mockResolvedValue(mockProfile) },
          activityLog: { create: jest.fn() },
        }),
      );

      mockCareRepo.createCarePlan.mockResolvedValue(mockCarePlan as any);
      mockMotherBabyRepo.createPregnancyProfile.mockResolvedValue(mockProfile as any);
      mockCareService.scheduleEvents.mockResolvedValue(undefined);
      mockCareRepo.createActivityLog.mockResolvedValue({} as any);

      // LMP date ~12 weeks ago — valid range
      const lmpDate = new Date();
      lmpDate.setDate(lmpDate.getDate() - 84);

      const result = await motherBabyService.setupPregnancy('user-1', {
        lmpDate: lmpDate.toISOString(),
      });

      expect(result).toBeDefined();
    });
  });

  describe('recordDelivery', () => {
    it('throws not found if no active pregnancy', async () => {
      mockMotherBabyRepo.findActivePregnancy.mockResolvedValue(null);

      await expect(
        motherBabyService.recordDelivery('user-1', { deliveryDate: '2024-09-01' }),
      ).rejects.toMatchObject({ errorCode: 'NOT_FOUND' });
    });

    it('throws conflict if pregnancy already completed', async () => {
      mockMotherBabyRepo.findActivePregnancy.mockResolvedValue({
        id: 'profile-1',
        carePlanId: 'plan-1',
        carePlan: { ...mockCarePlan, status: 'COMPLETED' },
      } as any);

      await expect(
        motherBabyService.recordDelivery('user-1', { deliveryDate: '2024-09-01' }),
      ).rejects.toMatchObject({ errorCode: 'CONFLICT' });
    });

    it('creates baby vaccination plan via transaction', async () => {
      mockMotherBabyRepo.findActivePregnancy.mockResolvedValue({
        id: 'profile-1',
        carePlanId: 'plan-1',
        carePlan: mockCarePlan,
      } as any);

      const babyPlan = { ...mockCarePlan, id: 'baby-plan-1', type: 'VACCINATION' as const };

      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn) =>
        fn({
          carePlan: {
            update: jest.fn().mockResolvedValue(mockCarePlan),
            create: jest.fn().mockResolvedValue(babyPlan),
          },
          activityLog: { create: jest.fn() },
        }),
      );

      mockCareRepo.updateCarePlanStatus.mockResolvedValue({} as any);
      mockCareRepo.createCarePlan.mockResolvedValue(babyPlan as any);
      mockCareService.scheduleEvents.mockResolvedValue(undefined);
      mockCareRepo.createActivityLog.mockResolvedValue({} as any);

      const result = await motherBabyService.recordDelivery('user-1', {
        deliveryDate: '2024-09-01',
        babyName: 'Amara',
      });

      expect(result).toBeDefined();
    });
  });

  describe('createStandaloneBabyProfile', () => {
    it('creates baby care plan without requiring a pregnancy', async () => {
      const babyPlan = { ...mockCarePlan, id: 'baby-plan-2', type: 'VACCINATION' as const };

      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn) =>
        fn({
          carePlan: { create: jest.fn().mockResolvedValue(babyPlan) },
          activityLog: { create: jest.fn() },
        }),
      );

      mockCareRepo.createCarePlan.mockResolvedValue(babyPlan as any);
      mockCareService.scheduleEvents.mockResolvedValue(undefined);
      mockCareRepo.createActivityLog.mockResolvedValue({} as any);

      const result = await motherBabyService.createStandaloneBabyProfile('user-1', {
        deliveryDate: '2024-09-01',
        babyName: 'Chidi',
      });

      expect(result).toBeDefined();
    });
  });
});
