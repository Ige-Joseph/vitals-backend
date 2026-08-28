import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';

import { authenticate, requireAdmin } from '@/middleware/auth.middleware';
import { AuthenticatedRequest } from '@/types/express';
import { ok, validationError } from '@/lib/response';
import { billingService } from './billing.service';
import { grantService } from './grant.service';
import { checkoutService } from './checkout.service';
import { prisma } from '@/lib/prisma';

const router = Router();

/**
 * What the tiers are, and what they cost.
 *
 * Mounted deliberately *before* `authenticate`. Everything it returns is the
 * same for every caller — the tier list, the prices, what each includes — so
 * requiring an account to read it bought no privacy and broke every shared
 * link to the billing page: a signed-out visitor got a 401 where they should
 * have got an answer to "what is Premium".
 *
 * Nothing account-specific is served here. Which tier you are on, what you
 * have been granted and what you are subscribed to all stay behind the
 * middleware below, on `/plan`.
 */
/**
 * @swagger
 * /billing/tiers:
 *   get:
 *     tags: [Billing]
 *     summary: What the tiers are and what they cost
 *     description: |
 *       **Unauthenticated.** Everything here is the same for every caller — the
 *       tier list, the prices, what each includes — so requiring an account
 *       bought no privacy and broke every shared link to the billing page.
 *
 *       Nothing account-specific is served here. Which tier you are on, what
 *       you have been granted and what you are subscribed to are all on
 *       `GET /billing/plan`, behind authentication.
 *
 *       Per-month cost and the saving against the dearest option are computed
 *       server-side so every surface shows the same number.
 *     security: []
 *     responses:
 *       200:
 *         description: Tiers, prices and whether a purchase can be started
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         tiers:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               tier:
 *                                 type: string
 *                                 enum: [FREE, PREMIUM]
 *                               name: { type: string }
 *                               summary: { type: string }
 *                               includes:
 *                                 type: array
 *                                 items: { type: string }
 *                               prices:
 *                                 type: array
 *                                 items:
 *                                   type: object
 *                                   properties:
 *                                     id: { type: string }
 *                                     label: { type: string }
 *                                     amountMinor: { type: integer }
 *                                     currency: { type: string, example: NGN }
 *                                     interval: { type: string, enum: [month, year] }
 *                                     intervalCount: { type: integer }
 *                                     perMonthMinor: { type: integer }
 *                                     savingPercent: { type: integer }
 *                                     savingMinorPerYear: { type: integer }
 *                         checkoutUrl: { type: string, format: uri }
 *                         checkoutAvailable:
 *                           type: boolean
 *                           description: >
 *                             False when no payment provider is configured. The
 *                             page keeps its placeholder rather than showing an
 *                             upgrade button that leads nowhere.
 */
router.get('/tiers', (_req, res, next) => {
  try {
    return ok(res, billingService.publicPlans(), 'Plans retrieved');
  } catch (err) {
    next(err);
  }
});

// Everything below this line requires an account.
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
  /** Why this changed — recorded on the grant, not guessed at later. */
  basis: z.string().min(1).max(200).default('admin-action'),
  /**
   * Optional, and only meaningful when granting. Omitted means the grant runs
   * until an admin revokes it.
   */
  expiresAt: z.coerce.date().optional(),
});

/**
 * The caller's tier, what it grants, and where a subscription is bought.
 *
 * Purchase happens on the web rather than in-app. `checkoutUrl` is absolute so
 * a wrapped build opens a browser instead of rendering it inside the app,
 * which is what keeps the purchase outside an app store's billing flow.
 */
/**
 * @swagger
 * /billing/plan:
 *   get:
 *     tags: [Billing]
 *     summary: The caller's tier, entitlements and subscription
 *     description: |
 *       Account-scoped: resolved from `req.user.sub`, never from a parameter.
 *
 *       The tier comes from what is being paid for — `User.planType` is a
 *       projection of it, not the answer. Includes everything
 *       `GET /billing/tiers` returns, so one client reading one endpoint still
 *       sees one payload.
 *
 *       `pendingCheckout` is a checkout that was started and has not finished.
 *       It says a checkout was started and when — **not** that a payment
 *       succeeded, which cannot be told apart from here.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Plan, entitlements, subscription and pending checkout
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         tier: { type: string, enum: [FREE, PREMIUM] }
 *                         entitlementSource:
 *                           type: string
 *                           enum: [subscription, grant, default]
 *                         entitlements:
 *                           type: object
 *                           properties:
 *                             managedPersonLimit: { type: integer }
 *                             connectionLimit: { type: integer }
 *                         subscription:
 *                           type: object
 *                           nullable: true
 *                           properties:
 *                             id: { type: string, format: uuid }
 *                             status: { type: string }
 *                             currentPeriodEnd: { type: string, format: date-time, nullable: true }
 *                             cancelAtPeriodEnd: { type: boolean }
 *                         pendingCheckout:
 *                           type: object
 *                           nullable: true
 *                           properties:
 *                             subscriptionId: { type: string, format: uuid }
 *                             priceId: { type: string }
 *                             startedAt: { type: string, format: date-time }
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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
/**
 * @swagger
 * /billing/checkout:
 *   post:
 *     tags: [Billing]
 *     summary: Start a purchase
 *     description: |
 *       Returns somewhere to send the payer, and nothing else. It is
 *       deliberately **not** a confirmation: the subscription becomes real when
 *       the provider says the money moved, on a webhook, and never because a
 *       browser came back.
 *
 *       An INCOMPLETE subscription row is created before the payer reaches the
 *       provider, so that a webhook arriving before this response has something
 *       to attach to. It grants nothing, so an abandoned checkout costs nothing.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [priceId]
 *             properties:
 *               priceId:
 *                 type: string
 *                 maxLength: 100
 *                 example: premium-monthly-2026-08
 *     responses:
 *       200:
 *         description: Where to send the payer
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         redirectUrl: { type: string, format: uri }
 *                         subscriptionId: { type: string, format: uuid }
 *                         priceId: { type: string }
 *                         amountMinor: { type: integer }
 *                         currency: { type: string }
 *       400:
 *         description: |
 *           No provider configured, the free plan was named, or the provider
 *           could not start a checkout
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: No such price
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Price retired, account erased, or already subscribed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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
/**
 * @swagger
 * /billing/subscriptions/{subscriptionId}/cancel:
 *   post:
 *     tags: [Billing]
 *     summary: Stop a subscription renewing
 *     description: |
 *       Ends the next charge, not today's access. The period already paid for
 *       is kept: `endedAt` stays null and entitlement runs to
 *       `currentPeriodEnd`.
 *
 *       Scoped to the caller's own subscriptions — the lookup pairs the id with
 *       `userId`, so another account's subscription is a 404.
 *
 *       Cancelling at the provider is best-effort. A provider that cannot be
 *       reached does not block the local cancellation; reconciliation retries
 *       it, because an account that stopped paying must stop being charged
 *       whether or not a third party is up.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: subscriptionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Cancelled locally; provider confirmation may be pending
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         cancelled: { type: boolean }
 *                         confirmedByProvider: { type: boolean }
 *                         accessUntil:
 *                           type: string
 *                           format: date-time
 *                           nullable: true
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: No such subscription on this account
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Already cancelled or expired
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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
/**
 * @swagger
 * /billing/dead-letters:
 *   get:
 *     tags: [Billing]
 *     summary: Billing events that gave up
 *     description: |
 *       **Admin only.** The payload is a provider's and it names customers and
 *       amounts, so this is not readable by the account it concerns.
 *
 *       Nothing retries these by design — which is exactly why something has to
 *       show them, or "dead-lettered" only means "lost somewhere quieter". A
 *       billing event that quietly stops being processed is money going wrong
 *       unobserved.
 *
 *       Most recent 100, newest first.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dead-lettered events
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         count: { type: integer }
 *                         events:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               id: { type: string, format: uuid }
 *                               provider: { type: string }
 *                               providerEventId: { type: string }
 *                               type: { type: string }
 *                               occurredAt: { type: string, format: date-time }
 *                               receivedAt: { type: string, format: date-time }
 *                               retryCount: { type: integer }
 *                               error: { type: string, nullable: true }
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Not an admin
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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
/**
 * @swagger
 * /billing/users/{userId}/plan:
 *   patch:
 *     tags: [Billing]
 *     summary: Set an account's tier
 *     description: |
 *       **Admin only.** The single write path for a tier — a payment provider's
 *       webhook, an admin action and a support script all land here rather than
 *       each setting columns themselves.
 *
 *       Limits are a ceiling on *new* only. Nothing is taken away on downgrade:
 *       an account that drops below its limit keeps every Person it already
 *       has, because health data must never become read-only because a
 *       subscription lapsed.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tier]
 *             properties:
 *               tier:
 *                 type: string
 *                 enum: [FREE, PREMIUM]
 *               basis:
 *                 type: string
 *                 maxLength: 200
 *                 default: admin-action
 *                 description: Why this changed. Recorded, not guessed at later.
 *     responses:
 *       200:
 *         description: Tier written and entitlements applied
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiResponse'
 *       400:
 *         description: Validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Not an admin
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Redundant change, or the account has been erased
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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
        expiresAt: parsed.data.expiresAt ?? null,
      });

      return ok(res, user, `Plan set to ${parsed.data.tier}`);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /billing/users/{userId}/entitlement:
 *   get:
 *     tags: [Billing]
 *     summary: (Admin) One account's entitlement, and why it has it
 *     description: |
 *       Answers "why does this account have Premium" without opening the
 *       database: the effective tier and where it comes from, the subscription
 *       if there is one, the grant currently running if there is one, and the
 *       history of everything granted before.
 *
 *       `effective` is the authoritative answer — the same calculation every
 *       gate uses. `planTypeProjection` is the cached column, exposed so that a
 *       drift between the two is visible rather than silent. They should always
 *       agree.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: The account's entitlement and grant history
 *       403:
 *         description: Not an administrator
 *       404:
 *         description: User not found
 */
router.get(
  '/users/:userId/entitlement',
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const overview = await grantService.overview(String(req.params.userId));
      return ok(res, overview, 'Entitlement retrieved');
    } catch (err) {
      next(err);
    }
  },
);

export default router;
