import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { TIER_ENTITLEMENTS, type BillingTier } from '@/config/billing.config';
import { entitlementService } from './entitlement.service';

const log = createLogger('grants');

/**
 * Premium given rather than bought.
 *
 * A grant is a decision someone made and has to be able to defend: who, when,
 * why, for how long, and who reversed it. The table is the audit trail, which
 * is the whole reason this exists instead of a column somebody set once.
 *
 * Nothing here touches subscriptions. A grant and a subscription are
 * independent facts about the same account, and the resolver takes the higher
 * of the two — so granting Premium to a subscriber changes nothing they can
 * see, and revoking it leaves what they paid for untouched.
 */

/**
 * `User.planType` is written through on every change here.
 *
 * It is a projection, not an input: nothing authorises against it — see the
 * note at the top of entitlement.service.ts. It is kept current because the
 * access token carries it and the admin list displays it, and a projection
 * that drifts is worse than no projection at all.
 *
 * The capacity columns move with it for the same reason. They are read by
 * `resolve` as a floor, so leaving them behind after a revoke would quietly
 * keep granting capacity the grant was supposed to carry.
 */
const syncProjection = async (userId: string): Promise<BillingTier> => {
  const tier = await entitlementService.tierFor(userId);
  const entitlements = TIER_ENTITLEMENTS[tier];

  await prisma.user.update({
    where: { id: userId },
    data: {
      planType: tier,
      managedPersonLimit: entitlements.managedPersonLimit,
      connectionLimit: entitlements.connectionLimit,
    },
  });

  return tier;
};

export const grantService = {
  /**
   * Give an account Premium.
   *
   * Refuses when one is already running. Stacking grants would leave two rows
   * both claiming to be the reason an account is Premium, and revoking one
   * would appear to do nothing — so a change of terms is a revoke and a new
   * grant, both recorded, rather than a silent second row.
   */
  async grant(input: {
    userId: string;
    tier: BillingTier;
    reason: string;
    expiresAt?: Date | null;
    source?: 'ADMIN' | 'PROMOTION' | 'SUPPORT';
    actorUserId: string;
  }) {
    const { userId, tier, reason, expiresAt, source, actorUserId } = input;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, erasedAt: true },
    });

    if (!user) throw AppError.notFound('User not found');
    if (user.erasedAt) throw AppError.conflict('This account has been erased');

    if (expiresAt && expiresAt <= new Date()) {
      throw AppError.badRequest('An expiry date must be in the future');
    }

    const existing = await entitlementService.activeGrant(userId);
    if (existing) {
      throw AppError.conflict(
        'This account already has an active grant. Revoke it before granting again.',
      );
    }

    const created = await prisma.entitlementGrant.create({
      data: {
        userId,
        tier,
        reason,
        expiresAt: expiresAt ?? null,
        source: source ?? 'ADMIN',
        grantedByUserId: actorUserId,
      },
      select: {
        id: true,
        tier: true,
        source: true,
        status: true,
        reason: true,
        expiresAt: true,
        grantedAt: true,
      },
    });

    const effectiveTier = await syncProjection(userId);

    log.info('Entitlement granted', {
      grantId: created.id,
      userId,
      tier,
      expiresAt: expiresAt?.toISOString() ?? null,
      actorUserId,
      effectiveTier,
    });

    return created;
  },

  /**
   * End the grant that is currently running.
   *
   * Recorded, never deleted: who reversed it, when, and why. A revoked grant
   * stays in the history because "this account had Premium for three months
   * and then did not" is a fact about the account, not noise.
   */
  async revoke(input: { userId: string; reason: string; actorUserId: string }) {
    const { userId, reason, actorUserId } = input;

    const active = await entitlementService.activeGrant(userId);
    if (!active) {
      throw AppError.conflict('This account has no active grant to revoke');
    }

    const revoked = await prisma.entitlementGrant.update({
      where: { id: active.id },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedByUserId: actorUserId,
        revokedReason: reason,
      },
      select: {
        id: true,
        tier: true,
        status: true,
        revokedAt: true,
        revokedReason: true,
      },
    });

    const effectiveTier = await syncProjection(userId);

    log.info('Entitlement revoked', {
      grantId: revoked.id,
      userId,
      actorUserId,
      effectiveTier,
    });

    return revoked;
  },

  /**
   * What an admin needs to see about one account's entitlement.
   *
   * The effective tier and where it comes from, the subscription if there is
   * one, the grant that is running if there is one, and everything that has
   * been granted before. Enough to answer "why does this account have Premium"
   * without opening the database.
   */
  async overview(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, planType: true },
    });

    if (!user) throw AppError.notFound('User not found');

    const [effective, history] = await Promise.all([
      entitlementService.effective(userId),
      prisma.entitlementGrant.findMany({
        where: { userId },
        orderBy: { grantedAt: 'desc' },
        take: 25,
        select: {
          id: true,
          tier: true,
          source: true,
          status: true,
          reason: true,
          expiresAt: true,
          grantedAt: true,
          revokedAt: true,
          revokedReason: true,
          grantedBy: { select: { id: true, email: true } },
          revokedBy: { select: { id: true, email: true } },
        },
      }),
    ]);

    return {
      user: { id: user.id, email: user.email },
      /** What the account actually gets, from the one resolver. */
      effective: { tier: effective.tier, source: effective.source },
      subscription: effective.subscription
        ? {
            id: effective.subscription.id,
            status: effective.subscription.status,
            currentPeriodEnd: effective.subscription.currentPeriodEnd,
          }
        : null,
      activeGrant: effective.grant,
      history,
      /**
       * The projection, exposed so a drift between it and `effective` is
       * visible rather than silent. They should always agree.
       */
      planTypeProjection: user.planType,
    };
  },
};
