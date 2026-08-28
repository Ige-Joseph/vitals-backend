import { prisma } from '@/lib/prisma';
import type { SubscriptionStatus } from '@prisma/client';

import { env } from '@/config/env';

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
   * PAST_DUE is additionally bounded by a grace window running from the failed
   * charge — `SUBSCRIPTION_PAST_DUE_GRACE_DAYS`, seven by default.
   *
   * `endedAt` overrides all of that. Cancelling *at period end* leaves it null
   * and the subscriber keeps what they paid for; cancelling *now* — which is
   * what an erasing or deactivating account does — sets it, and access stops
   * immediately regardless of how much of the period is left. Without this
   * check a departed account would keep its entitlement for weeks.
   */
  async activeSubscription(userId: string) {
    const now = new Date();
    const graceCutoff = new Date(
      now.getTime() - env.SUBSCRIPTION_PAST_DUE_GRACE_DAYS * 86_400_000,
    );

    return prisma.subscription.findFirst({
      where: {
        userId,
        status: { in: [...GRANTING] },
        OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: now } }],
        AND: [
          { OR: [{ endedAt: null }, { endedAt: { gt: now } }] },
          // PAST_DUE is bounded by its own window, measured from the failed
          // charge. Past it, entitlement goes regardless of where the paid
          // period happens to end — otherwise a card that failed on day one of
          // a year-long term would keep Premium for eleven more months.
          {
            OR: [
              { status: { not: 'PAST_DUE' } },
              { pastDueSince: null },
              { pastDueSince: { gt: graceCutoff } },
            ],
          },
        ],
      },
      orderBy: { createdAt: 'desc' },
      include: { price: true },
    });
  },

  async resolve(userId: string): Promise<Entitlement> {
    const [user, subscription] = await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { managedPersonLimit: true, connectionLimit: true, planType: true },
      }),
      entitlementService.activeSubscription(userId),
    ]);

    // Same precedence as tierFor: a subscription is the fact, and planType is
    // the projection an admin grant writes.
    //
    // This used to read the subscription alone, which made an admin-granted
    // account report FREE here while every gate — all of which go through
    // tierFor — served it as PREMIUM. The account was entitled and told it was
    // not: the upgrade prompt showed, the feature worked if called directly.
    // Two functions answering "what tier is this account" differently is the
    // bug; keeping them in step is the fix.
    const tier = (subscription?.price.tier ?? user.planType ?? 'FREE') as BillingTier;
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

    // `grant` now covers both shapes a manual grant can take: raised capacity
    // columns, and a planType lifted without a subscription behind it. Before,
    // a tier-only grant reported `default`, which read as "this account is on
    // the free tier by nature" rather than "someone gave this to them".
    const source: EntitlementSource = subscription
      ? 'subscription'
      : grantExceedsTier || tier !== 'FREE'
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
    //
    // `resolve` applies the same precedence deliberately. If these two ever
    // disagree again, an account is entitled by one and refused by the other.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { planType: true },
    });
    return (user?.planType ?? 'FREE') as BillingTier;
  },
};
