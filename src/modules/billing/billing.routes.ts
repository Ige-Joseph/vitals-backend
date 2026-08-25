import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';

import { authenticate, requireAdmin } from '@/middleware/auth.middleware';
import { AuthenticatedRequest } from '@/types/express';
import { ok, validationError } from '@/lib/response';
import { billingService } from './billing.service';

const router = Router();

router.use(authenticate);

const setPlanSchema = z.object({
  tier: z.enum(['FREE', 'PREMIUM']),
  /** Why this changed — recorded in the log, not guessed at later. */
  basis: z.string().min(1).max(200).default('admin-action'),
});

/**
 * The caller's tier, what it grants, and where a subscription is bought.
 *
 * Purchase happens on the web rather than in-app. `checkoutUrl` is absolute so
 * a wrapped build opens a browser instead of rendering it inside the app,
 * which is what keeps the purchase outside an app store's billing flow.
 */
router.get('/plan', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const plan = await billingService.getPlan(req.user!.sub);
    return ok(res, plan, 'Plan retrieved');
  } catch (err) {
    next(err);
  }
});

/**
 * Write a tier.
 *
 * Admin-only for now, and deliberately so: this is the write path a payment
 * provider's webhook will call once one exists, and having it real and tested
 * beforehand is what makes adding the provider a small change rather than a
 * large one. No payment integration is wired here.
 */
router.patch(
  '/users/:userId/plan',
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = setPlanSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

      const user = await billingService.setPlan({
        userId: String(req.params.userId),
        tier: parsed.data.tier,
        actorUserId: req.user!.sub,
        basis: parsed.data.basis,
      });

      return ok(res, user, `Plan set to ${parsed.data.tier}`);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
