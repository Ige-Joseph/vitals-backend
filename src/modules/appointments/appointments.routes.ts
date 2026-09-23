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

/**
 * @swagger
 * /appointments:
 *   post:
 *     tags: [Appointments]
 *     summary: Book an appointment for a Person
 *     description: |
 *       Creates an appointment on a Person's record. Behind it sits a care plan
 *       of type APPOINTMENT, one care event at the appointment time, and one
 *       reminder per configured lead time.
 *
 *       Rules:
 *       - `personId` names whose record this is. Omit it and the appointment is
 *         booked on the caller's own Person.
 *       - Booking on someone else's record requires an active membership with
 *         write access (OWNER or CAREGIVER). A VIEWER is refused.
 *       - `startsAt` must be in the future.
 *       - A lead time that would already have passed simply produces no
 *         reminder; it is not an error.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, startsAt]
 *             properties:
 *               personId:
 *                 type: string
 *                 format: uuid
 *                 description: Whose record. Defaults to the caller's own Person.
 *               title:
 *                 type: string
 *                 example: Cardiology follow-up
 *               startsAt:
 *                 type: string
 *                 format: date-time
 *                 example: "2026-09-14T10:00:00.000Z"
 *               durationMinutes:
 *                 type: integer
 *                 default: 30
 *                 example: 45
 *               clinician:
 *                 type: string
 *                 example: Dr Adeyemi
 *               specialty:
 *                 type: string
 *                 example: Cardiology
 *               location:
 *                 type: string
 *                 example: Lagos University Teaching Hospital
 *               reason:
 *                 type: string
 *                 example: Six-month review
 *               notes:
 *                 type: string
 *                 example: Bring the previous ECG
 *               reminderLeadMinutes:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 default: [1440, 60]
 *                 example: [1440, 60]
 *                 description: Minutes before the start to remind. Deduplicated; at most five.
 *     responses:
 *       201:
 *         description: Appointment scheduled
 *       400:
 *         description: Validation failed, or the time has already passed
 *       403:
 *         description: No write access to that Person
 *       404:
 *         description: Person not found
 */
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

/**
 * @swagger
 * /appointments:
 *   get:
 *     tags: [Appointments]
 *     summary: List a Person's appointments
 *     description: |
 *       Returns appointments for one Person, nearest the present first. Results
 *       are scoped to the resolved subject — an appointment belonging to any
 *       other Person is never included, whatever the caller asks for.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: personId
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Whose record. Defaults to the caller's own Person.
 *       - in: query
 *         name: scope
 *         schema:
 *           type: string
 *           enum: [upcoming, past, all]
 *           default: upcoming
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [SCHEDULED, CONFIRMED, COMPLETED, CANCELLED, MISSED]
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 100
 *     responses:
 *       200:
 *         description: Appointments retrieved
 *       403:
 *         description: No read access to that Person
 */
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

/**
 * @swagger
 * /appointments/{id}:
 *   get:
 *     tags: [Appointments]
 *     summary: Read one appointment
 *     description: |
 *       Returns 404 rather than 403 when the appointment exists but belongs to
 *       another Person and no `personId` was named — the subject resolves to
 *       the caller's own Person, and within that record the row does not exist.
 *       Naming another Person explicitly is refused at the access check with a
 *       403 instead.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: personId
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Appointment retrieved
 *       403:
 *         description: No read access to the named Person
 *       404:
 *         description: No such appointment on this Person's record
 */
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

/**
 * @swagger
 * /appointments/{id}:
 *   patch:
 *     tags: [Appointments]
 *     summary: Change an appointment
 *     description: |
 *       Changing `startsAt` or `reminderLeadMinutes` re-derives the schedule:
 *       the existing care event and its reminders are withdrawn and replaced,
 *       and any calendar entry is cleaned up and laid down again. Changing
 *       anything else leaves the schedule untouched.
 *
 *       `status` is not settable here. Cancelling and completing are their own
 *       endpoints because each has consequences beyond a column.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: At least one field is required.
 *             properties:
 *               personId:
 *                 type: string
 *                 format: uuid
 *               title:
 *                 type: string
 *               startsAt:
 *                 type: string
 *                 format: date-time
 *               durationMinutes:
 *                 type: integer
 *               clinician:
 *                 type: string
 *                 nullable: true
 *               specialty:
 *                 type: string
 *                 nullable: true
 *               location:
 *                 type: string
 *                 nullable: true
 *               reason:
 *                 type: string
 *                 nullable: true
 *               notes:
 *                 type: string
 *                 nullable: true
 *               reminderLeadMinutes:
 *                 type: array
 *                 items:
 *                   type: integer
 *     responses:
 *       200:
 *         description: Appointment updated
 *       400:
 *         description: Validation failed, or the new time has already passed
 *       403:
 *         description: No write access to that Person
 *       404:
 *         description: No such appointment on this Person's record
 *       409:
 *         description: Already cancelled or already completed
 */
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
/**
 * @swagger
 * /appointments/{id}/cancel:
 *   post:
 *     tags: [Appointments]
 *     summary: Call an appointment off
 *     description: |
 *       Marks the appointment CANCELLED, withdraws any pending reminders and
 *       removes the calendar entry. The row is kept, never deleted — that an
 *       appointment was going to happen is part of the record.
 *
 *       Calendar cleanup is best-effort: an unreachable calendar never prevents
 *       a cancellation.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               personId:
 *                 type: string
 *                 format: uuid
 *               reason:
 *                 type: string
 *                 example: Clinic closed
 *     responses:
 *       200:
 *         description: Appointment cancelled
 *       403:
 *         description: No write access to that Person
 *       404:
 *         description: No such appointment on this Person's record
 *       409:
 *         description: Already cancelled
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

/**
 * @swagger
 * /appointments/{id}/complete:
 *   post:
 *     tags: [Appointments]
 *     summary: Mark an appointment as attended
 *     description: |
 *       Marks the appointment COMPLETED, withdraws any pending reminders and
 *       closes the underlying care plan.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               personId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Appointment marked as attended
 *       403:
 *         description: No write access to that Person
 *       404:
 *         description: No such appointment on this Person's record
 *       409:
 *         description: The appointment was cancelled
 */
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
