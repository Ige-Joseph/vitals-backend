import { AppError } from '@/lib/errors';
import { userRepository, UpdateProfileInput } from './user.repository';
import { createLogger } from '@/lib/logger';

const log = createLogger('user-service');

export const userService = {
  async getProfile(userId: string) {
    const user = await userRepository.findById(userId);
    if (!user) throw AppError.notFound('User not found');
    return user;
  },

  async updateProfile(userId: string, data: UpdateProfileInput) {
    const user = await userRepository.findById(userId);
    if (!user) throw AppError.notFound('User not found');

    const profile = await userRepository.upsertProfile(userId, data);
    log.info('Profile updated', { userId });
    return profile;
  },

  // ─── Admin ────────────────────────────────────────────────────────────

  async deactivateUser(adminId: string, targetUserId: string) {
    if (adminId === targetUserId) {
      throw AppError.badRequest('You cannot deactivate your own account');
    }
    const user = await userRepository.findById(targetUserId);
    if (!user) throw AppError.notFound('User not found');
    if (!user.isActive) throw AppError.conflict('User is already deactivated');

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
