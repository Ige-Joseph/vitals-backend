import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { env } from '@/config/env';
import { createLogger } from '@/lib/logger';
import {
  TIER_ENTITLEMENTS,
  TIER_DESCRIPTIONS,
  type BillingTier,
} from '@/config/billing.config';

const log = createLogger('billing-service');

/**
 * The billing tier — `PlanType` on User, not `CarePlan`.
 *
 * The two are unrelated and the codebase calls both "plan". A CarePlan is a
 * course of care and is person-scoped; PlanType is what an account pays for
 * and is account-scoped, permanently. Nothing here touches CarePlan.
 *
 * Until now nothing in the codebase ever wrote planType, so every account was
 * FREE forever: the meter was built and the door never was. This is the door.
 * It deliberately stops short of a payment provider — the write path and the
 * entitlement wiring come first, so a provider only has to call `setPlan`.
 */
export const billingService = {
  /**
   * Where a subscription is actually bought.
   *
   * Purchase happens on the web, outside any app store's payment flow. That is
   * a commercial decision as much as a technical one: an in-app digital
   * purchase on Play would have to go through Play Billing, at a fee that
   * matters on a low-priced subscription in this market.
   *
   * Returned as an absolute URL so a wrapped build opens it in a browser
   * rather than rendering it inside the app.
   */
  checkoutUrl(): string {
    return `${env.FRONTEND_URL.replace(/\/$/, '')}/billing`;
  },

  /** The caller's tier, what it grants, and what the other tier would. */
  async getPlan(userId: string) {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        planType: true,
        managedPersonLimit: true,
        connectionLimit: true,
      },
    });

    const tier = user.planType as BillingTier;

    return {
      tier,
      description: TIER_DESCRIPTIONS[tier],
      // The account's actual columns, which may differ from the tier default
      // if someone was granted an override.
      entitlements: {
        managedPersonLimit: user.managedPersonLimit,
        connectionLimit: user.connectionLimit,
      },
      tiers: Object.values(TIER_DESCRIPTIONS),
      checkoutUrl: billingService.checkoutUrl(),
    };
  },

  /**
   * Write the tier and apply its entitlements.
   *
   * This is the single write path. A payment provider, an admin action and a
   * support script all land here rather than each setting columns themselves.
   *
   * Limits are a ceiling on *new* only — nothing is taken away on downgrade.
   * An account that drops below its limit keeps every Person it already has;
   * health data must never become read-only because a subscription lapsed.
   */
  async setPlan(input: {
    userId: string;
    tier: BillingTier;
    actorUserId: string;
    basis: string;
  }) {
    const { userId, tier, actorUserId, basis } = input;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, planType: true, erasedAt: true },
    });

    if (!user) throw AppError.notFound('User not found');
    if (user.erasedAt) throw AppError.conflict('This account has been erased');

    if (user.planType === tier) {
      throw AppError.conflict(`This account is already on the ${tier} plan`);
    }

    const entitlements = TIER_ENTITLEMENTS[tier];

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        planType: tier,
        managedPersonLimit: entitlements.managedPersonLimit,
        connectionLimit: entitlements.connectionLimit,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        planType: true,
        emailVerified: true,
        managedPersonLimit: true,
        connectionLimit: true,
      },
    });

    log.info('Billing tier changed', {
      userId,
      from: user.planType,
      to: tier,
      actorUserId,
      basis,
    });

    return updated;
  },
};
