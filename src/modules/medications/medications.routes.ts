import { Router, Response, NextFunction } from 'express';
import { medicationsService } from './medications.service';
import { createMedicationSchema } from './medications.validators';
import { authenticate } from '@/middleware/auth.middleware';
import { ok, created, validationError } from '@/lib/response';
import { AuthenticatedRequest } from '@/types/express';

const router = Router();
router.use(authenticate);

/**
 * @swagger
 * /medications:
 *   post:
 *     tags: [Medications]
 *     summary: Create a medication plan and generate dose schedule
 *     description: |
 *       Creates a medication care plan, stores the medication details, generates all scheduled dose events, and creates reminders through the shared care engine.
 *
 *       Rules:
 *       - Provide either durationDays or endDate, but not both.
 *       - customTimes must match frequency:
 *         - ONCE_DAILY = 1 time
 *         - TWICE_DAILY = 2 times
 *         - THREE_TIMES_DAILY = 3 times
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, dosage, frequency, startDate, customTimes]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Paracetamol
 *               dosage:
 *                 type: string
 *                 example: 500mg
 *               frequency:
 *                 type: string
 *                 enum: [ONCE_DAILY, TWICE_DAILY, THREE_TIMES_DAILY]
 *                 example: TWICE_DAILY
 *               startDate:
 *                 type: string
 *                 format: date
 *                 example: "2026-04-20"
 *               endDate:
 *                 type: string
 *                 format: date
 *                 example: "2026-04-26"
 *                 description: Provide either endDate or durationDays, but not both.
 *               durationDays:
 *                 type: integer
 *                 example: 7
 *                 description: Provide either durationDays or endDate, but not both.
 *               customTimes:
 *                 type: array
 *                 items:
 *                   type: string
 *                   example: "08:00"
 *                 example: ["08:00", "20:00"]
 *                 description: Number of customTimes must match the selected frequency. ONCE_DAILY = 1, TWICE_DAILY = 2, THREE_TIMES_DAILY = 3.
 *               instructions:
 *                 type: string
 *                 example: Take after food
 *           examples:
 *             onceDaily:
 *               summary: Once daily medication
 *               value:
 *                 name: Paracetamol
 *                 dosage: 500mg
 *                 frequency: ONCE_DAILY
 *                 startDate: "2026-04-20"
 *                 durationDays: 7
 *                 customTimes: ["08:00"]
 *                 instructions: Take after food
 *             twiceDaily:
 *               summary: Twice daily medication
 *               value:
 *                 name: Amoxicillin
 *                 dosage: 250mg
 *                 frequency: TWICE_DAILY
 *                 startDate: "2026-04-20"
 *                 durationDays: 5
 *                 customTimes: ["08:00", "20:00"]
 *                 instructions: Take morning and evening after meals
 *             threeTimesDaily:
 *               summary: Three times daily medication
 *               value:
 *                 name: Vitamin C
 *                 dosage: 1000mg
 *                 frequency: THREE_TIMES_DAILY
 *                 startDate: "2026-04-20"
 *                 durationDays: 5
 *                 customTimes: ["08:00", "14:00", "20:00"]
 *                 instructions: Take after meals
 *     responses:
 *       201:
 *         description: Medication plan created with schedule
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
 *                   example: Medication plan created
 *                 data:
 *                   type: object
 *                   properties:
 *                     carePlan:
 *                       type: object
 *                     medication:
 *                       type: object
 *                     scheduledDoses:
 *                       type: integer
 *                       example: 10
 *                 errorCode:
 *                   type: string
 *                   nullable: true
 *                   example: null
 *       400:
 *         description: Invalid medication scheduling input
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
router.post('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = createMedicationSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

    const result = await medicationsService.createMedication(req.user!.sub, parsed.data as any);
    return created(res, result, 'Medication plan created');
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /medications:
 *   get:
 *     tags: [Medications]
 *     summary: List all medication plans for the current user
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Medication list
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const medications = await medicationsService.listMedications(req.user!.sub);
    return ok(res, medications, 'Medications retrieved');
  } catch (err) {
    next(err);
  }
});




/**
 * @swagger
 * /medications/{carePlanId}/history:
 *   get:
 *     tags: [Medications]
 *     summary: Get medication dose history
 *     description: "Returns the full dose history for a medication plan, including past, current, and future doses with status: PENDING, DONE, SKIPPED, or MISSED."
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: carePlanId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Medication dose history retrieved
 */
router.get(
  '/:carePlanId/history',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const carePlanId = req.params.carePlanId as string;

      const history = await medicationsService.getMedicationHistory(
        req.user!.sub,
        carePlanId,
      );

      return ok(res, history, 'Medication history retrieved');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /medications/{carePlanId}:
 *   get:
 *     tags: [Medications]
 *     summary: Get a single medication plan
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: carePlanId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Medication details
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Medication not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/:carePlanId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const carePlanId = req.params.carePlanId as string;

    const medication = await medicationsService.getMedication(
      req.user!.sub,
      carePlanId
    );

    return ok(res, medication, 'Medication retrieved');
  } catch (err) {
    next(err);
  }
});


/**
 * @swagger
 * /medications/{carePlanId}:
 *   delete:
 *     tags: [Medications]
 *     summary: Deactivate a medication plan
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: carePlanId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Medication deactivated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiResponse'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Medication not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Medication plan already completed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.delete('/:carePlanId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const carePlanId = req.params.carePlanId as string;

    await medicationsService.deactivateMedication(
      req.user!.sub,
      carePlanId
    );
    return ok(res, null, 'Medication plan deactivated');
  } catch (err) {
    next(err);
  }
});

export default router;