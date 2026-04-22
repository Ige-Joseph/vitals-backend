import { Router, Response, NextFunction } from 'express';
import { quotaService } from './quota.service';
import { authenticate } from '@/middleware/auth.middleware';
import { ok } from '@/lib/response';
import { AuthenticatedRequest } from '@/types/express';

const router = Router();
router.use(authenticate);

/**
 * @swagger
 * /usage:
 *   get:
 *     tags: [Usage]
 *     summary: Return AI usage and daily quota state
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Usage summary with limits
 */
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const usage = await quotaService.getUsage(req.user!.sub, req.user!.planType);
    return ok(res, usage, 'Usage retrieved');
  } catch (err) {
    next(err);
  }
});

export default router;
