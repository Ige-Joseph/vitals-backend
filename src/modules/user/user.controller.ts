import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { userService } from './user.service';
import { ok } from '@/lib/response';
import { AuthenticatedRequest } from '@/types/express';

const updateProfileSchema = z.object({
  gender: z.enum(['MALE', 'FEMALE', 'NON_BINARY', 'PREFER_NOT_TO_SAY']).optional(),
  timezone: z.string().optional(),
  selectedJourney: z.enum(['MEDICATION', 'PREGNANCY', 'VACCINATION']).optional(),
  notificationPreferences: z.record(z.string(), z.unknown()).optional(),
});

export const userController = {
  async getProfile(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const data = await userService.getProfile(req.user!.sub);
      return ok(res, data, 'Profile retrieved');
    } catch (err) {
      next(err);
    }
  },

  async updateProfile(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const parsed = updateProfileSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(422).json({
          success: false,
          data: null,
          message: parsed.error.issues[0].message,
          errorCode: 'VALIDATION_ERROR',
        });
      }

      const payload = {
        ...parsed.data,
        notificationPreferences:
          parsed.data.notificationPreferences as Prisma.InputJsonValue | undefined,
      };

      const profile = await userService.updateProfile(req.user!.sub, payload);
      return ok(res, profile, 'Profile updated');
    } catch (err) {
      next(err);
    }
  },

  async listUsers(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
      const data = await userService.listUsers(page, limit);
      return ok(res, data, 'Users retrieved');
    } catch (err) {
      next(err);
    }
  },

  async deactivateUser(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.params.userId as string;
      await userService.deactivateUser(req.user!.sub, userId);
      return ok(res, null, 'User deactivated');
    } catch (err) {
      next(err);
    }
  },

  async reactivateUser(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.params.userId as string;
      await userService.reactivateUser(req.user!.sub, userId);
      return ok(res, null, 'User reactivated');
    } catch (err) {
      next(err);
    }
  },
};