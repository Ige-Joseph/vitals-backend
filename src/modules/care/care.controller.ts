import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { careService } from './care.service';
import { ok, validationError } from '@/lib/response';
import { AuthenticatedRequest } from '@/types/express';

const updateStatusSchema = z.object({
  status: z.enum(['DONE', 'SKIPPED', 'PENDING']),
});

export const careController = {
  async listEvents(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { status, type, from, to } = req.query as Record<string, string>;
      const events = await careService.listEvents(req.user!.sub, {
        status: status as any,
        type,
        from,
        to,
      });
      return ok(res, events, 'Care events retrieved');
    } catch (err) {
      next(err);
    }
  },

  async updateEventStatus(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const parsed = updateStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        return validationError(res, parsed.error.issues[0].message);
      }

      const eventId = req.params.id as string;

      const event = await careService.updateEventStatus(
        req.user!.sub,
        eventId,
        parsed.data.status,
      );

      return ok(res, event, 'Event status updated');
    } catch (err) {
      next(err);
    }
  },
};