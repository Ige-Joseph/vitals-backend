import { prisma } from '@/lib/prisma';
import type { SubscriptionStatus } from '@prisma/client';

import { TIER_ENTITLEMENTS, type BillingTier } from '@/config/billing.config';

/**
 * What an account is entitled to, resolved from what it is paying for.
 *
 * `User.planType` is no longer the answer. It is a cached projection of this,
 * kept so existing reads and the admin path keep working, but a subscription
 * is the fact and planType is a copy of it — and a copy can be stale in ways
 * that matter, because the money says one thing and the column says another.
 *
 * Entitlement is account-scoped. It is never resolved per Person: a Person
 * that granted capacity would be a thing you could buy more of by adding
 * people, which is the loop this whole model exists to avoid.
 */

/** Statuses that still grant. */
const GRANTING = ['ACTIVE', 'PAST_DUE', 'CANCELED'] as const satisfies readonly SubscriptionStatus[];

export type EntitlementSource = 'subscription' | 'grant' | 'default';

export interface Entitlement {
  tier: BillingTier;
  source: EntitlementSource;
  managedPersonLimit: number;
  connectionLimit: number;
  subscription: {
    id: string;
    status: string;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
  } | null;
}

export const entitlementService = {
  /**
   * The subscription currently granting entitlement, if any.
   *
   * PAST_DUE still grants: a renewal that failed is a payment problem, and
   * losing access to a dependent's records the day a card expires is the wrong
   * failure. CANCELED still grants until the period ends, because it was paid
   * for. Both are bounded by currentPeriodEnd, so neither grants forever.
   *
   * `endedAt` overrides all of that. Cancelling *at period end* leaves it null
   * and the subscriber keeps what they paid for; cancelling *now* — which is
   * what an erasing or deactivating account does — sets it, and access stops
   * immediately regardless of how much of the period is left. Without this
   * check a departed account would keep its entitlement for weeks.
   */
  async activeSubscription(userId: string) {
    const now = new Date();

    return prisma.subscription.findFirst({
      where: {
        userId,
        status: { in: [...GRANTING] },
        OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: now } }],
        AND: [{ OR: [{ endedAt: null }, { endedAt: { gt: now } }] }],
      },
      orderBy: { createdAt: 'desc' },
      include: { price: true },
    });
  },

  async resolve(userId: string): Promise<Entitlement> {
    const [user, subscription] = await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { managedPersonLimit: true, connectionLimit: true },
      }),
      entitlementService.activeSubscription(userId),
    ]);

    const tier = (subscription?.price.tier ?? 'FREE') as BillingTier;
    const base = TIER_ENTITLEMENTS[tier];

    // The columns on User are a manual grant — a support decision, a pilot
    // account — and never reduce what a subscription bought. Taking the higher
    // of the two means a grant tops up rather than replaces, and an expiring
    // subscription cannot silently strip a grant that was given separately.
    const managedPersonLimit = Math.max(base.managedPersonLimit, user.managedPersonLimit);
    const connectionLimit = Math.max(base.connectionLimit, user.connectionLimit);

    const grantExceedsTier =
      user.managedPersonLimit > base.managedPersonLimit ||
      user.connectionLimit > base.connectionLimit;

    const source: EntitlementSource = subscription
      ? 'subscription'
      : grantExceedsTier
        ? 'grant'
        : 'default';

    return {
      tier,
      source,
      managedPersonLimit,
      connectionLimit,
      subscription: subscription
        ? {
            id: subscription.id,
            status: subscription.status,
            currentPeriodEnd: subscription.currentPeriodEnd,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          }
        : null,
    };
  },

  /**
   * Just the tier. Quota reads this rather than the access token, so an
   * upgrade takes effect on the next request instead of the next refresh.
   */
  async tierFor(userId: string): Promise<BillingTier> {
    const subscription = await entitlementService.activeSubscription(userId);
    if (subscription) return subscription.price.tier as BillingTier;

    // No subscription: fall back to the projection, which the admin grant path
    // writes. Removing this would make a manual grant stop granting.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { planType: true },
    });
    return (user?.planType ?? 'FREE') as BillingTier;
  },
};
