import { prisma } from '@/lib/prisma';
import type { PrismaTx } from '@/types/prisma';
import { Prisma } from '@prisma/client';

export interface UpdateProfileInput {
  firstName?: string;
  lastName?: string;
  gender?: 'MALE' | 'FEMALE' | 'NON_BINARY' | 'PREFER_NOT_TO_SAY';
  country?: string;
  timezone?: string;
  notificationPreferences?: Prisma.InputJsonValue;
  selectedJourney?: 'MEDICATION' | 'PREGNANCY' | 'VACCINATION';
}

export const userRepository = {
  findById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        planType: true,
        emailVerified: true,
        isActive: true,
        createdAt: true,
        profile: true,
      },
    });
  },

  updateUserNames(
    userId: string,
    data: { firstName?: string; lastName?: string },
    tx?: PrismaTx,
  ) {
    const client = tx ?? prisma;
    return client.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        firstName: true,
        lastName: true,
      },
    });
  },

  upsertProfile(
    userId: string,
    data: Omit<UpdateProfileInput, 'firstName' | 'lastName'>,
    tx?: PrismaTx,
  ) {
    const client = tx ?? prisma;
    return client.profile.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  },

  getProfile(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        profile: true,
      },
    });
  },

  setActiveStatus(userId: string, isActive: boolean) {
    return prisma.user.update({
      where: { id: userId },
      data: { isActive },
    });
  },

  listUsers(page: number, limit: number) {
    const skip = (page - 1) * limit;
    return Promise.all([
      prisma.user.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          planType: true,
          emailVerified: true,
          isActive: true,
          createdAt: true,
        },
      }),
      prisma.user.count(),
    ]);
  },
};