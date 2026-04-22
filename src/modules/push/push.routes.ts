import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/middleware/auth.middleware';
import { ok, created, validationError } from '@/lib/response';
import { AuthenticatedRequest } from '@/types/express';

const router = Router();
router.use(authenticate);

const registerSchema = z.object({
  // FCM token obtained by the frontend via Firebase SDK getToken()
  token: z.string().min(10, 'FCM token is required'),
});

/**
 * @swagger
 * /push/register:
 *   post:
 *     tags: [Push]
 *     summary: Register an FCM token for the authenticated user
 *     description: |
 *       Called by the frontend after obtaining an FCM token via Firebase SDK.
 *       Uses upsert — safe to call on every app load.
 *       One user can register multiple tokens (multi-device support).
 *       Invalid tokens are automatically removed by the reminder worker after a failed send.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token:
 *                 type: string
 *                 description: FCM token from Firebase SDK getToken()
 *     responses:
 *       201:
 *         description: Token registered
 *       422:
 *         description: Validation error
 */
router.post('/register', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

    // Upsert: unique constraint on token prevents duplicates.
    // If the same token is re-registered (e.g. app refresh), we just update updatedAt.
    await prisma.pushToken.upsert({
      where: { token: parsed.data.token },
      create: {
        userId: req.user!.sub,
        token: parsed.data.token,
      },
      update: {
        // Re-associate with current user in case of re-login on same device
        userId: req.user!.sub,
      },
    });

    return created(res, null, 'Push token registered');
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /push/register:
 *   delete:
 *     tags: [Push]
 *     summary: Remove an FCM token (user disables notifications or logs out)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Token removed
 */
router.delete('/register', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { token } = req.body;
    if (!token) return validationError(res, 'token is required');

    await prisma.pushToken.deleteMany({
      where: { token, userId: req.user!.sub },
    });

    return ok(res, null, 'Push token removed');
  } catch (err) {
    next(err);
  }
});

export default router;
