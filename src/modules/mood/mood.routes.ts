import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/middleware/auth.middleware';
import { ok, created, validationError } from '@/lib/response';
import { AuthenticatedRequest } from '@/types/express';
import {
  MOOD_OPTIONS,
  CRAVING_OPTIONS,
  MoodOption,
  CravingOption,
  generateInsight,
} from '@/config/mood.config';
import { createLogger } from '@/lib/logger';

const log = createLogger('mood');
const router = Router();
router.use(authenticate);

const logMoodSchema = z
  .object({
    mood: z.enum(MOOD_OPTIONS).optional(),
    craving: z.enum(CRAVING_OPTIONS).optional(),
  })
  .refine((d) => d.mood || d.craving, {
    message: 'At least one of mood or craving is required',
  });

/**
 * @swagger
 * /mood/options:
 *   get:
 *     tags: [Mood]
 *     summary: Return predefined mood and craving option sets
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Mood and craving options
 */
router.get('/options', (_req, res: Response) => {
  return ok(
    res,
    { moods: [...MOOD_OPTIONS], cravings: [...CRAVING_OPTIONS] },
    'Options retrieved',
  );
});

/**
 * @swagger
 * /mood/log:
 *   post:
 *     tags: [Mood]
 *     summary: Submit a mood and/or craving entry — returns immediate rule-based insight
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mood:
 *                 type: string
 *                 enum: [HAPPY, CALM, ANXIOUS, TIRED, SAD, EMOTIONAL, IRRITABLE, STRESSED, ENERGETIC, OVERWHELMED]
 *               craving:
 *                 type: string
 *                 enum: [SWEET, SALTY, SPICY, SOUR, COLD_DRINKS, WARM_FOOD, NO_APPETITE, VERY_HUNGRY, NAUSEOUS]
 *     responses:
 *       201:
 *         description: Log entry created with insight
 *       422:
 *         description: At least one of mood or craving required
 */
router.post('/log', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = logMoodSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

    const { mood, craving } = parsed.data;
    const insight = generateInsight(mood as MoodOption, craving as CravingOption);

    const entry = await prisma.$transaction(async (tx: any) => {
      const log_entry = await tx.moodLog.create({
        data: {
          userId: req.user!.sub,
          mood: mood ?? null,
          craving: craving ?? null,
          insight,
          loggedAt: new Date(),
        },
      });

      await tx.activityLog.create({
        data: {
          userId: req.user!.sub,
          type: 'MOOD_LOGGED',
          message: 'Mood and craving entry recorded',
          metadata: { mood, craving, moodLogId: log_entry.id },
        },
      });

      return log_entry;
    });

    log.info('Mood logged', { userId: req.user!.sub, mood, craving });

    return created(res, { ...entry, insight }, 'Mood log recorded');
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /mood/history:
 *   get:
 *     tags: [Mood]
 *     summary: Fetch previous mood and craving logs
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Mood log history
 */
router.get('/history', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
    const skip = (page - 1) * limit;

    const [entries, total] = await Promise.all([
      prisma.moodLog.findMany({
        where: { userId: req.user!.sub },
        orderBy: { loggedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.moodLog.count({ where: { userId: req.user!.sub } }),
    ]);

    return ok(
      res,
      { entries, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
      'Mood history retrieved',
    );
  } catch (err) {
    next(err);
  }
});

export default router;
