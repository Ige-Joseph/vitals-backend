import { Router, Response, NextFunction } from 'express';
import { dashboardService } from './dashboard.service';
import { authenticate } from '@/middleware/auth.middleware';
import { ok } from '@/lib/response';
import { AuthenticatedRequest } from '@/types/express';

const router = Router();
router.use(authenticate);

/**
 * @swagger
 * /dashboard:
 *   get:
 *     tags: [Dashboard]
 *     summary: Aggregated dashboard — today's tasks, upcoming reminders, recent activity, usage, and mother/baby summary
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Dashboard retrieved
 *                 data:
 *                   type: object
 *                   properties:
 *                     todayTasks:
 *                       type: array
 *                       items:
 *                         type: object
 *                     upcomingReminders:
 *                       type: array
 *                       items:
 *                         type: object
 *                     recentActivity:
 *                       type: array
 *                       items:
 *                         type: object
 *                     usageSummary:
 *                       type: object
 *                       properties:
 *                         symptomChecksUsed:
 *                           type: integer
 *                           example: 0
 *                         symptomChecksLimit:
 *                           type: integer
 *                           example: 3
 *                         drugDetectionsUsed:
 *                           type: integer
 *                           example: 0
 *                         drugDetectionsLimit:
 *                           type: integer
 *                           example: 3
 *                     latestMoodInsight:
 *                       type: object
 *                       nullable: true
 *                     motherBabySummary:
 *                       type: object
 *                       properties:
 *                         pregnancies:
 *                           type: object
 *                           properties:
 *                             total:
 *                               type: integer
 *                               example: 3
 *                             active:
 *                               type: integer
 *                               example: 1
 *                             completed:
 *                               type: integer
 *                               example: 2
 *                         babies:
 *                           type: object
 *                           properties:
 *                             total:
 *                               type: integer
 *                               example: 2
 *                             standalone:
 *                               type: integer
 *                               example: 1
 *                             fromPregnancy:
 *                               type: integer
 *                               example: 1
 *                 errorCode:
 *                   type: string
 *                   nullable: true
 *                   example: null
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const data = await dashboardService.getDashboard(req.user!.sub);
    return ok(res, data, 'Dashboard retrieved');
  } catch (err) {
    next(err);
  }
});

export default router;