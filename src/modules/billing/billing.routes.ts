import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';

import { authenticate, requireAdmin } from '@/middleware/auth.middleware';
import { AuthenticatedRequest } from '@/types/express';
import { ok, validationError } from '@/lib/response';
import { billingService } from './billing.service';
import { checkoutService } from './checkout.service';
import { prisma } from '@/lib/prisma';

const router = Router();

router.use(authenticate);

const startCheckoutSchema = z.object({
  /**
   * Which price, chosen on /billing. Carried all the way to the provider and
   * stored on the subscription — a subscription that did not know what it was
   * bought at could not be grandfathered through a repricing.
   */
  priceId: z.string().min(1).max(100),
});

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
 * Start a purchase.
 *
 * Returns somewhere to send the payer, and nothing else. It is deliberately
 * not a confirmation: the subscription becomes real when the provider says the
 * money moved, on a webhook, and never because a browser came back.
 */
router.post('/checkout', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = startCheckoutSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

    const session = await checkoutService.start({
      userId: req.user!.sub,
      priceId: parsed.data.priceId,
    });

    return ok(res, session, 'Checkout started');
  } catch (err) {
    next(err);
  }
});

/**
 * Stop a subscription renewing.
 *
 * The period already paid for is kept — this ends the next charge, not
 * today's access.
 */
router.post(
  '/subscriptions/:subscriptionId/cancel',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await checkoutService.cancel({
        userId: req.user!.sub,
        subscriptionId: String(req.params.subscriptionId),
      });
      return ok(res, result, 'Subscription cancelled');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Billing events that gave up.
 *
 * Nothing retries these, by design — so something has to show them, or
 * "dead-lettered" just means "lost somewhere quieter". Admin-only: the payload
 * is a provider's, and it names customers and amounts.
 */
router.get(
  '/dead-letters',
  requireAdmin,
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const events = await prisma.billingWebhookEvent.findMany({
        where: { status: 'DEAD_LETTERED' },
        orderBy: { receivedAt: 'desc' },
        take: 100,
        select: {
          id: true,
          provider: true,
          providerEventId: true,
          type: true,
          occurredAt: true,
          receivedAt: true,
          retryCount: true,
          error: true,
        },
      });

      return ok(res, { count: events.length, events }, 'Dead-lettered billing events');
    } catch (err) {
      next(err);
    }
  },
);

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
