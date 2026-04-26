import { Router, Response, NextFunction } from 'express';
import { motherBabyService } from './mother-baby.service';
import {
  setupPregnancySchema,
  recordDeliverySchema,
  babyProfileSchema,
} from './mother-baby.validators';
import { authenticate } from '@/middleware/auth.middleware';
import { ok, created, validationError } from '@/lib/response';
import { AuthenticatedRequest } from '@/types/express';

const router = Router();
router.use(authenticate);

/**
 * @swagger
 * /mother-baby/setup:
 *   post:
 *     tags: [Mother & Baby]
 *     summary: Create pregnancy care plan and generate ANC timeline
 *     description: |
 *       Creates a pregnancy care plan, stores the pregnancy profile, and schedules only the remaining ANC milestones.
 *
 *       Setup options:
 *       - Option A: Provide lmpDate if the user knows the last menstrual period date.
 *       - Option B: Provide pregnancyWeekAtSetup if the user only knows the current pregnancy week.
 *
 *       Provide either lmpDate OR pregnancyWeekAtSetup, but not both.
 *       If both are provided, the request will be rejected.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               lmpDate:
 *                 type: string
 *                 format: date
 *                 example: "2026-04-21"
 *                 description: Last menstrual period date in YYYY-MM-DD format. Preferred input.
 *               pregnancyWeekAtSetup:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 42
 *                 example: 12
 *                 description: Current pregnancy week. Use this only if lmpDate is not available.
 *           examples:
 *             usingLmpDate:
 *               summary: Option A — Setup using LMP date
 *               value:
 *                 lmpDate: "2026-04-21"
 *             usingPregnancyWeek:
 *               summary: Option B — Setup using current pregnancy week
 *               value:
 *                 pregnancyWeekAtSetup: 12
 */
router.post('/setup', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = setupPregnancySchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

    const result = await motherBabyService.setupPregnancy(req.user!.sub, parsed.data);
    return created(res, result, 'Pregnancy plan created');
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /mother-baby/timeline:
 *   get:
 *     tags: [Mother & Baby]
 *     summary: Fetch current pregnancy week, trimester, EDD, and upcoming ANC events
 *     description: Returns the active pregnancy timeline, recalculated from LMP in real time, including guidance and upcoming ANC visits.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Pregnancy timeline
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
 *                   example: Pregnancy timeline retrieved
 *                 data:
 *                   type: object
 *                   properties:
 *                     currentWeek:
 *                       type: integer
 *                       example: 16
 *                     trimester:
 *                       type: integer
 *                       example: 2
 *                     expectedDeliveryDate:
 *                       type: string
 *                       format: date-time
 *                     lmpDate:
 *                       type: string
 *                       format: date-time
 *                     guidance:
 *                       type: object
 *                       nullable: true
 *                     upcomingANCVisits:
 *                       type: array
 *                       items:
 *                         type: object
 *                     allMilestones:
 *                       type: array
 *                       items:
 *                         type: object
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
 *       404:
 *         description: No active pregnancy found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/timeline', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const timeline = await motherBabyService.getTimeline(req.user!.sub);
    return ok(res, timeline, 'Pregnancy timeline retrieved');
  } catch (err) {
    next(err);
  }
});




/**
 * @swagger
 * /mother-baby/pregnancy/cancel:
 *   patch:
 *     tags: [Mother & Baby]
 *     summary: Cancel active pregnancy timeline
 *     description: Cancels the current active pregnancy timeline so the user can set up a new one.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Pregnancy timeline cancelled
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: No active pregnancy timeline found
 */
router.patch('/pregnancy/cancel', async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await motherBabyService.cancelPregnancyTimeline(req.user!.sub);
    return ok(res, result, 'Pregnancy timeline cancelled');
  } catch (err) {
    next(err);
  }
});


/**
 * @swagger
 * /mother-baby/delivery:
 *   post:
 *     tags: [Mother & Baby]
 *     summary: Record delivery and create baby vaccination plan
 *     description: Atomically closes the active pregnancy plan, cancels pending pregnancy reminders, and opens a baby vaccination plan with scheduled vaccination events.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [deliveryDate]
 *             properties:
 *               deliveryDate:
 *                 type: string
 *                 format: date
 *                 example: "2026-10-01"
 *                 description: Delivery date in YYYY-MM-DD format.
 *               babyName:
 *                 type: string
 *                 example: David
 *           examples:
 *             delivery:
 *               summary: Record delivery
 *               value:
 *                 deliveryDate: "2026-10-01"
 *                 babyName: David
 *     responses:
 *       201:
 *         description: Delivery recorded and vaccination schedule generated
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
 *                   example: Delivery recorded and baby vaccination plan created
 *                 data:
 *                   type: object
 *                   properties:
 *                     babyCarePlan:
 *                       type: object
 *                     vaccinationsScheduled:
 *                       type: integer
 *                       example: 8
 *                 errorCode:
 *                   type: string
 *                   nullable: true
 *                   example: null
 *       400:
 *         description: Invalid delivery date
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: No active pregnancy found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Pregnancy plan already completed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       422:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/delivery', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = recordDeliverySchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

    const result = await motherBabyService.recordDelivery(req.user!.sub, parsed.data);
    return created(res, result, 'Delivery recorded and baby vaccination plan created');
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /mother-baby/baby-profile:
 *   get:
 *     tags: [Mother & Baby]
 *     summary: Get baby vaccination profiles for current user
 *     description: Returns all vaccination care plans for the current user, including standalone baby profiles and baby plans created after delivery.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Baby vaccination plans (empty array if none)
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
 *                   example: Baby profiles retrieved
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
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
router.get('/baby-profile', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const profiles = await motherBabyService.getBabyProfile(req.user!.sub);
    return ok(res, profiles, 'Baby profiles retrieved');
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /mother-baby/baby-profile:
 *   post:
 *     tags: [Mother & Baby]
 *     summary: Create a standalone baby profile (no pregnancy required)
 *     description: Creates a baby vaccination plan directly from delivery date without requiring a prior pregnancy record.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [deliveryDate]
 *             properties:
 *               deliveryDate:
 *                 type: string
 *                 format: date
 *                 example: "2026-10-01"
 *                 description: Delivery date in YYYY-MM-DD format.
 *               babyName:
 *                 type: string
 *                 example: Sarah
 *           examples:
 *             standaloneBaby:
 *               summary: Create standalone baby profile
 *               value:
 *                 deliveryDate: "2026-10-01"
 *                 babyName: Sarah
 *     responses:
 *       201:
 *         description: Baby profile created with vaccination schedule
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
 *                   example: Baby profile created
 *                 data:
 *                   type: object
 *                   properties:
 *                     babyCarePlan:
 *                       type: object
 *                     vaccinationsScheduled:
 *                       type: integer
 *                       example: 8
 *                 errorCode:
 *                   type: string
 *                   nullable: true
 *                   example: null
 *       400:
 *         description: Invalid delivery date
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       422:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/baby-profile', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = babyProfileSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

    const result = await motherBabyService.createStandaloneBabyProfile(
      req.user!.sub,
      parsed.data,
    );
    return created(res, result, 'Baby profile created');
  } catch (err) {
    next(err);
  }
});

export default router;