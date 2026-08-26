import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import type { PrismaTx } from '@/types/prisma';
import { providerRegistry } from './provider/provider.registry';

const log = createLogger('subscription-service');

/**
 * Subscription lifecycle at the edges where billing meets the rest of the
 * system — specifically, an account going away while it is still paying.
 *
 * Webhooks and reconciliation are a later session. What is here is the part
 * that other modules already need: an account that erases or deactivates must
 * not keep being charged.
 */
export const subscriptionService = {
  /** Subscriptions that could still bill this account. */
  async billableFor(userId: string) {
    return prisma.subscription.findMany({
      where: {
        userId,
        status: { in: ['INCOMPLETE', 'ACTIVE', 'PAST_DUE'] },
      },
    });
  },

  /**
   * Stop charging an account that is leaving.
   *
   * Called by erasure and by deactivation, and it must never throw: a data
   * subject's right to erasure does not depend on a payment provider being
   * reachable, and blocking an archive on a third-party outage would be the
   * wrong trade every time.
   *
   * So the local record is always closed, and the *provider* call is
   * best-effort. `cancellationRequestedAt` without a matching
   * `cancellationConfirmedAt` is the signal that something is still live at the
   * provider and needs retrying — which is reconciliation's job, next session.
   * Recording the gap is what makes that possible; swallowing it silently is
   * what would leave someone being charged for an account that no longer
   * exists.
   */
  async cancelAllForAccount(
    userId: string,
    reason: string,
  ): Promise<{ cancelled: number; unconfirmed: number }> {
    const subscriptions = await subscriptionService.billableFor(userId);
    if (subscriptions.length === 0) return { cancelled: 0, unconfirmed: 0 };

    let unconfirmed = 0;
    const now = new Date();

    for (const subscription of subscriptions) {
      const result = await providerRegistry.tryCancel(subscription, reason);

      if (!result.confirmed) unconfirmed += 1;

      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          status: 'CANCELED',
          cancelAtPeriodEnd: false,
          canceledAt: now,
          // Ends now rather than at period end: an account that no longer
          // exists must not keep holding entitlement.
          endedAt: now,
          cancellationRequestedAt: now,
          cancellationConfirmedAt: result.confirmed ? now : null,
        },
      });

      log.info('Subscription cancelled for departing account', {
        subscriptionId: subscription.id,
        userId,
        confirmed: result.confirmed,
        detail: result.detail,
        reason,
      });
    }

    if (unconfirmed > 0) {
      log.error('Subscriptions cancelled locally but unconfirmed at the provider', {
        userId,
        unconfirmed,
        reason,
      });
    }

    return { cancelled: subscriptions.length, unconfirmed };
  },

  /**
   * Detach an erased account's billing records without destroying them.
   *
   * A refund or chargeback can arrive weeks after erasure, and it has to land
   * somewhere: a payment is a financial record with its own basis for
   * retention, and it is not the erased subject's to delete. So the rows
   * survive with their personal link removed — `providerReference` and
   * `providerCustomerRef` carry no personal data and are what a late refund
   * matches on.
   *
   * The subscription row itself keeps `userId`, because it is RESTRICT and the
   * user row survives as a tombstone. Nothing about the person remains on it.
   */
  async detachFromErasedAccount(userId: string, tx: PrismaTx): Promise<void> {
    await tx.paymentTransaction.updateMany({
      where: { userId },
      data: { userId: null },
    });
  },
};
