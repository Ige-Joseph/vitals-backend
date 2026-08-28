import { prisma } from '@/lib/prisma';
import type { SubscriptionStatus } from '@prisma/client';

import { env } from '@/config/env';

import { TIER_ENTITLEMENTS, type BillingTier } from '@/config/billing.config';

/**
 * What an account is entitled to, resolved from what it is paying for.
 *
 * Two things grant it, and neither is `User.planType`:
 *
 *   * an active paid subscription
 *   * an active EntitlementGrant — Premium given rather than bought
 *
 * The higher of the two wins, and both are read here. This is the only place
 * that calculates it; `tierFor` and `resolve` are two shapes of one answer,
 * because when they were two answers an admin-granted account was refused by
 * one and served by the other.
 *
 * `User.planType` is a **projection** and is deliberately not read. It is
 * written through on grant and revoke, and it survives for three reasons: the
 * access token carries it, the admin user list displays it, and older reads
 * expect it. None of those are authorisation. Reading it here would make it a
 * second source of truth again, which is the bug this model replaced — so if
 * you find yourself reaching for it in this file, that is the mistake.
 *
 * Entitlement is account-scoped. It is never resolved per Person: a Person
 * that granted capacity would be a thing you could buy more of by adding
 * people, which is the loop this whole model exists to avoid.
 */

/** Statuses that still grant. */
/**
 * Which tier wins when an account has more than one.
 *
 * A comparison rather than a precedence list, so a subscription and a grant
 * can both be present without either silently erasing the other.
 */
const TIER_RANK: Record<BillingTier, number> = { FREE: 0, PREMIUM: 1 };

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

  /**
   * The grant currently granting, if any.
   *
   * Expiry is a `WHERE` clause, not a status. A grant whose `expiresAt` has
   * passed stops granting at that instant, whether or not anything has run
   * since — there is no sweep to fall behind, and no column to be stale.
   *
   * Newest first, so a re-grant supersedes an older one without needing the
   * older one revoked first.
   */
  async activeGrant(userId: string) {
    const now = new Date();

    return prisma.entitlementGrant.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { grantedAt: 'desc' },
      select: {
        id: true,
        tier: true,
        source: true,
        expiresAt: true,
        grantedAt: true,
        reason: true,
      },
    });
  },

  /**
   * The one calculation. Everything else in this file is a shape of it.
   *
   * A subscription and a grant can both be present, and the answer is the
   * higher tier rather than either one alone. `source` names what is carrying
   * it: money first, because that is the fact with an invoice behind it, but
   * the grant stays live underneath and takes over the moment the subscription
   * lapses. A failed card must not remove something nobody paid for.
   */
  async effective(userId: string) {
    const [subscription, grant] = await Promise.all([
      entitlementService.activeSubscription(userId),
      entitlementService.activeGrant(userId),
    ]);

    const subscriptionTier = (subscription?.price.tier ?? 'FREE') as BillingTier;
    const grantTier = (grant?.tier ?? 'FREE') as BillingTier;
    const tier = TIER_RANK[grantTier] > TIER_RANK[subscriptionTier] ? grantTier : subscriptionTier;

    const source: EntitlementSource =
      subscription && TIER_RANK[subscriptionTier] >= TIER_RANK[grantTier]
        ? 'subscription'
        : grant
          ? 'grant'
          : 'default';

    return { tier, source, subscription, grant };
  },

  async resolve(userId: string): Promise<Entitlement> {
    const [user, effective] = await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { managedPersonLimit: true, connectionLimit: true },
      }),
      entitlementService.effective(userId),
    ]);

    const { tier, subscription } = effective;
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

    // Raised capacity columns are still a grant, even with no EntitlementGrant
    // row behind them — they are set directly for pilot accounts and support
    // cases. So `default` means "free, and nobody gave this account anything".
    const source: EntitlementSource =
      effective.source === 'default' && grantExceedsTier ? 'grant' : effective.source;

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
    return (await entitlementService.effective(userId)).tier;
  },
};
