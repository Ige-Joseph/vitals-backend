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
 *     summary: Update a care event status using careEventId
 *     description: |
 *       Updates the status of a specific care event.
 *       
 *       ⚠️ IMPORTANT:
 *       - The `id` in the path is the **care event ID**, not the care plan ID.
 *       - Use the `id` returned from GET /care/events.
 *       
 *       Example flow:
 *       1. Call GET /care/events
 *       2. Pick an event from the response
 *       3. Use that event's `id` here
 *
 *     security:
 *       - bearerAuth: []
 *
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Care event ID (NOT carePlanId)
 *         example: "6e54befb-2444-446e-91d2-a2e8b1945335"
 *
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
 *                 example: DONE
 *
 *     responses:
 *       200:
 *         description: Event status updated successfully
 *       403:
 *         description: Not your event
 *       404:
 *         description: Care event not found
 */
router.patch('/events/:id/status', careController.updateEventStatus);

export default router;
