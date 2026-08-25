import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { userRepository, UpdateProfileInput } from './user.repository';
import { personService } from '@/modules/person/person.service';
import { personHealthService } from '@/modules/person/person.health.service';
import { createLogger } from '@/lib/logger';

const log = createLogger('user-service');

export const userService = {
  /**
   * Account settings. The clinical half now lives on the Person.
   *
   * The `profile` block keeps every key it had, so no client breaks — but the
   * clinical values in it are read from PersonHealthProfile, not from the
   * columns on Profile. Those columns are retained and unread for the
   * compatibility window. `health` is the canonical block; the clinical keys
   * inside `profile` are deprecated and go when the window closes.
   */
  async getProfile(userId: string) {
    const user = await userRepository.getProfile(userId);
    if (!user) throw AppError.notFound('User not found');

    const health = await personHealthService.get(userId);

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      profile: user.profile
        ? {
            ...user.profile,
            // Deprecated mirror, sourced from the Person.
            bloodGroup: health.bloodGroup,
            genotype: health.genotype,
            heightCm: health.heightCm,
            weightKg: health.weightKg,
            allergies: health.allergies,
            existingConditions: health.existingConditions,
            currentMedications: health.currentMedications,
            disabilities: health.disabilities,
            smokingStatus: health.smokingStatus,
            alcoholUse: health.alcoholUse,
          }
        : user.profile,
      health,
    };
  },

  async updateProfile(userId: string, data: UpdateProfileInput) {
    const user = await userRepository.findById(userId);
    if (!user) throw AppError.notFound('User not found');

    const {
      firstName,
      lastName,
      bloodGroup,
      genotype,
      heightCm,
      weightKg,
      allergies,
      existingConditions,
      currentMedications,
      disabilities,
      smokingStatus,
      alcoholUse,
      ...profileData
    } = data as Record<string, any>;

    // Clinical fields sent to this endpoint are routed to the caller's own
    // Person rather than written to Profile, so existing clients keep working
    // while the data lands in its new home.
    const clinical = {
      bloodGroup,
      genotype,
      heightCm,
      weightKg,
      allergies,
      existingConditions,
      currentMedications,
      disabilities,
      smokingStatus,
      alcoholUse,
    };

    if (Object.values(clinical).some((v) => v !== undefined)) {
      await personHealthService.update(userId, clinical);
    }

    const result = await prisma.$transaction(
      async (tx) => {
        if (firstName !== undefined || lastName !== undefined) {
          await userRepository.updateUserNames(
            userId,
            {
              ...(firstName !== undefined ? { firstName } : {}),
              ...(lastName !== undefined ? { lastName } : {}),
            },
            tx,
          );
        }

        const profile = await userRepository.upsertProfile(userId, profileData, tx);

        return profile;
      },
      {
        timeout: 15000,
        maxWait: 10000,
      },
    );

    log.info('Profile updated', { userId });
    return result;
  },

  async deactivateUser(adminId: string, targetUserId: string) {
    if (adminId === targetUserId) {
      throw AppError.badRequest('You cannot deactivate your own account');
    }
    const user = await userRepository.findById(targetUserId);
    if (!user) throw AppError.notFound('User not found');
    if (!user.isActive) throw AppError.conflict('User is already deactivated');

    // Archive is the only removal path, and it must not strand anyone. An
    // account that is the sole manager of an unclaimed health record has to
    // hand it over, or have it claimed or archived, first — otherwise that
    // person's reminders simply stop with nobody notified.
    await personService.assertCanArchiveAccount(targetUserId);

    await userRepository.setActiveStatus(targetUserId, false);
    log.info('User deactivated', { adminId, targetUserId });
  },

  async reactivateUser(adminId: string, targetUserId: string) {
    const user = await userRepository.findById(targetUserId);
    if (!user) throw AppError.notFound('User not found');
    if (user.isActive) throw AppError.conflict('User is already active');

    await userRepository.setActiveStatus(targetUserId, true);
    log.info('User reactivated', { adminId, targetUserId });
  },

  async listUsers(page = 1, limit = 20) {
    const [users, total] = await userRepository.listUsers(page, limit);
    return {
      users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  },
};