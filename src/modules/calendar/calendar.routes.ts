import { Router } from 'express';
import { authenticate } from '@/middleware/auth.middleware';
import { calendarController } from './calendar.controller';

const router = Router();

/**
 * @swagger
 * /calendar/google/callback:
 *   get:
 *     tags: [Calendar]
 *     summary: Google OAuth callback
 *     description: |
 *       Google redirects here after user grants calendar permissions.
 *
 *       Backend exchanges the authorization code for:
 *       - access token
 *       - refresh token
 *
 *       Then stores CalendarIntegration for the user.
 *
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *
 *       - in: query
 *         name: state
 *         required: true
 *         schema:
 *           type: string
 *
 *     responses:
 *       302:
 *         description: Redirects user back to frontend after successful Google Calendar connection
 */
router.get('/google/callback', calendarController.googleCallback);

router.use(authenticate);

/**
 * @swagger
 * /calendar/google/connect:
 *   get:
 *     tags: [Calendar]
 *     summary: Generate Google Calendar OAuth URL
 *     security:
 *       - bearerAuth: []
 *
 *     responses:
 *       200:
 *         description: OAuth URL generated successfully
 */
router.get('/google/connect', calendarController.connectGoogle);

/**
 * @swagger
 * /calendar/care-plans/{carePlanId}/sync:
 *   post:
 *     tags: [Calendar]
 *     summary: Sync care plan events to Google Calendar
 *     security:
 *       - bearerAuth: []
 *
 *     parameters:
 *       - in: path
 *         name: carePlanId
 *         required: true
 *         schema:
 *           type: string
 *         description: Care plan ID to sync
 *
 *     responses:
 *       200:
 *         description: Calendar sync completed
 */
router.post('/care-plans/:carePlanId/sync', calendarController.syncCarePlan);




/**
 * @swagger
 * /calendar/care-plans/{carePlanId}/cleanup:
 *   post:
 *     tags: [Calendar]
 *     summary: Remove synced Google Calendar events for a care plan
 *     description: |
 *       Deletes all synced Google Calendar events linked to the specified care plan.
 *
 *       This is typically used when:
 *       - a medication plan is deactivated
 *       - a pregnancy timeline is cancelled
 *       - a baby vaccination timeline is cancelled
 *
 *       Successfully deleted links are marked as CLEANUP_RESOLVED.
 *       Failed deletions are marked as CLEANUP_REQUIRED for retry later.
 *
 *     security:
 *       - bearerAuth: []
 *
 *     parameters:
 *       - in: path
 *         name: carePlanId
 *         required: true
 *         schema:
 *           type: string
 *         description: Care plan ID whose calendar events should be removed
 *
 *     responses:
 *       200:
 *         description: Calendar cleanup completed
 *       400:
 *         description: Google Calendar is not connected
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Care plan not found
 */
router.post(
  '/care-plans/:carePlanId/cleanup',
  calendarController.cleanupCarePlan,
);



/**
 * @swagger
 * /calendar/sync/summary:
 *   get:
 *     summary: Get Google Calendar sync summary
 *     description: Returns counts of synced, pending, failed, and cleanup-required calendar events for the authenticated user.
 *     tags:
 *       - Calendar
 *     security:
 *       - bearerAuth: []
 *
 *     responses:
 *       200:
 *         description: Calendar sync summary retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *
 *                 message:
 *                   type: string
 *                   example: Calendar sync summary retrieved
 *
 *                 data:
 *                   type: object
 *                   properties:
 *                     SYNCED:
 *                       type: number
 *                       example: 12
 *
 *                     PENDING:
 *                       type: number
 *                       example: 2
 *
 *                     SYNC_FAILED:
 *                       type: number
 *                       example: 1
 *
 *                     CLEANUP_REQUIRED:
 *                       type: number
 *                       example: 1
 *
 *       400:
 *         description: Google Calendar is not connected
 *
 *       401:
 *         description: Unauthorized
 */
router.get('/sync/summary', calendarController.getSyncSummary);

/**
 * @swagger
 * /calendar/sync/retry-failed:
 *   post:
 *     tags:
 *       - Calendar
 *     summary: Retry failed Google Calendar syncs
 *     description: |
 *       Retries all pending or failed Google Calendar event syncs for the authenticated user.
 *
 *       This is useful when:
 *       - Google Calendar was temporarily unavailable
 *       - token refresh failed temporarily
 *       - a previous sync attempt failed
 *
 *     security:
 *       - bearerAuth: []
 *
 *     responses:
 *       200:
 *         description: Calendar retry completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *
 *                 message:
 *                   type: string
 *                   example: Calendar retry completed
 *
 *                 data:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: number
 *                       example: 5
 *
 *                     synced:
 *                       type: number
 *                       example: 4
 *
 *                     failed:
 *                       type: number
 *                       example: 1
 *
 *       400:
 *         description: Google Calendar is not connected
 *
 *       401:
 *         description: Unauthorized
 */
router.post('/sync/retry-failed', calendarController.retryFailedSyncs);

export default router;