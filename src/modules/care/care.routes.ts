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
 *         schema:
 *           type: string
 *           enum: [PENDING, DONE, SKIPPED, MISSED]
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date-time
 *     responses:
 *       200:
 *         description: Care event list
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
