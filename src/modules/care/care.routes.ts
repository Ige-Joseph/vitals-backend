import { Router } from 'express';
import { careController } from './care.controller';
import { authenticate } from '@/middleware/auth.middleware';

const router = Router();

router.use(authenticate);

/**
 * @swagger
 * /care/events:
 *   get:
 *     tags: [Care]
 *     summary: Fetch care timeline — filterable by status, type, date range
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         required: false
 *         schema:
 *           type: string
 *           enum: [PENDING, DONE, SKIPPED, MISSED]
 *         example: PENDING
 *         description: Filter events by status
 *
 *       - in: query
 *         name: type
 *         required: false
 *         schema:
 *           type: string
 *           enum: [MEDICATION_DOSE, ANC_VISIT, ANC_SCAN, VACCINATION]
 *         example: MEDICATION_DOSE
 *         description: Filter events by type
 *
 *       - in: query
 *         name: from
 *         required: false
 *         schema:
 *           type: string
 *           format: date-time
 *         example: "2026-04-20T00:00:00.000Z"
 *         description: Return events scheduled from this date (ISO 8601)
 *
 *       - in: query
 *         name: to
 *         required: false
 *         schema:
 *           type: string
 *           format: date-time
 *         example: "2026-04-30T23:59:59.999Z"
 *         description: Return events scheduled up to this date (ISO 8601)
 *
 *     responses:
 *       200:
 *         description: Care events retrieved successfully
 */
router.get('/events', careController.listEvents);

/**
 * @swagger
 * /care/events/{id}/status:
 *   patch:
 *     tags: [Care]
 *     summary: Mark a care event as done, skipped, or restore to pending
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [DONE, SKIPPED, PENDING]
 *     responses:
 *       200:
 *         description: Status updated
 *       403:
 *         description: Not your event
 *       404:
 *         description: Event not found
 */
router.patch('/events/:id/status', careController.updateEventStatus);

export default router;
