import { Router, Response, NextFunction } from 'express';

import { authenticate } from '@/middleware/auth.middleware';
import { AuthenticatedRequest } from '@/types/express';
import { ok, created, validationError } from '@/lib/response';
import { appointmentsService } from './appointments.service';
import {
  cancelAppointmentSchema,
  createAppointmentSchema,
  listAppointmentsSchema,
  updateAppointmentSchema,
} from './appointments.validators';

const router = Router();

router.use(authenticate);

/**
 * Appointments, for a Person.
 *
 * Every route takes an optional `personId` — as a query parameter on reads, in
 * the body on writes — meaning "whose record". Omitted, it resolves to the
 * caller's own Person. The routes never decide access themselves: each one
 * hands the pair to the service, which resolves it through `personAccess`
 * before touching a row. There is no route here that can be reached without
 * that resolution happening.
 */

/** `personId` is only ever a request for a subject, never a grant of one. */
const personIdFrom = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

router.post('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = createAppointmentSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

    const appointment = await appointmentsService.create(req.user!.sub, parsed.data);
    return created(res, appointment, 'Appointment scheduled');
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = listAppointmentsSchema.safeParse(req.query);
    if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

    const appointments = await appointmentsService.list(req.user!.sub, parsed.data);
    return ok(res, appointments, 'Appointments retrieved');
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const appointment = await appointmentsService.get(
      req.user!.sub,
      String(req.params.id),
      personIdFrom(req.query.personId),
    );
    return ok(res, appointment, 'Appointment retrieved');
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = updateAppointmentSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

    const appointment = await appointmentsService.update(
      req.user!.sub,
      String(req.params.id),
      parsed.data,
      personIdFrom(req.body?.personId),
    );
    return ok(res, appointment, 'Appointment updated');
  } catch (err) {
    next(err);
  }
});

/**
 * Cancelling is its own route rather than a status on PATCH.
 *
 * It withdraws reminders and cleans up a calendar entry, and a general PATCH
 * that could set CANCELLED would let those be skipped by accident.
 */
router.post('/:id/cancel', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = cancelAppointmentSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

    const appointment = await appointmentsService.cancel(
      req.user!.sub,
      String(req.params.id),
      parsed.data.reason,
      personIdFrom(req.body?.personId),
    );
    return ok(res, appointment, 'Appointment cancelled');
  } catch (err) {
    next(err);
  }
});

router.post(
  '/:id/complete',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const appointment = await appointmentsService.complete(
        req.user!.sub,
        String(req.params.id),
        personIdFrom(req.body?.personId),
      );
      return ok(res, appointment, 'Appointment marked as attended');
    } catch (err) {
      next(err);
    }
  },
);

export default router;
