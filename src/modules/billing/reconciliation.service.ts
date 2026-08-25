import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import { providerRegistry } from './provider/provider.registry';

const log = createLogger('billing-reconciliation');

/**
 * Periodic agreement between our state and the provider's.
 *
 * Webhooks are the fast path and they are not a guarantee: deliveries are
 * dropped, endpoints are down for a deploy, signatures rotate mid-flight. A
 * system whose billing state depends solely on receiving every event will
 * eventually be wrong and have no way to notice. This is the slow path that
 * notices.
 *
 * It does two jobs, and the second is the more important one: retrying the
 * cancellations that erasure and deactivation recorded but could not confirm.
 * Those are accounts that no longer exist still being billed, which is the
 * worst failure this system can produce.
 */
export const reconciliationService = {
  /**
   * Retry cancellations we asked for and never had confirmed.
   *
   * `cancellationRequestedAt` set with no `cancellationConfirmedAt` is the
   * marker erasure leaves behind when the provider was unreachable. It is
   * deliberately not fatal at the time — a data subject's erasure cannot wait
   * on a third party — so it has to be picked up here instead.
   */
  async retryUnconfirmedCancellations(): Promise<{ attempted: number; confirmed: number }> {
    const pending = await prisma.subscription.findMany({
      where: {
        cancellationRequestedAt: { not: null },
        cancellationConfirmedAt: null,
        providerSubscriptionId: { not: null },
      },
      take: 100,
      orderBy: { cancellationRequestedAt: 'asc' },
    });

    let confirmed = 0;

    for (const subscription of pending) {
      const result = await providerRegistry.tryCancel(
        subscription.provider,
        subscription.providerSubscriptionId,
        'reconciliation-retry',
      );

      if (result.confirmed) {
        confirmed += 1;
        await prisma.subscription.update({
          where: { id: subscription.id },
          data: { cancellationConfirmedAt: new Date() },
        });
      }
    }

    if (pending.length > 0) {
      log.info('Retried unconfirmed cancellations', {
        attempted: pending.length,
        confirmed,
        stillUnconfirmed: pending.length - confirmed,
      });
    }

    // An entry that keeps failing is worth shouting about — it means money is
    // still moving for an account that asked to leave.
    if (pending.length - confirmed > 0) {
      log.error('Subscriptions remain live at the provider after a cancellation request', {
        count: pending.length - confirmed,
      });
    }

    return { attempted: pending.length, confirmed };
  },

  /**
   * Compare our view of live subscriptions with the provider's and correct
   * ours where they differ.
   *
   * The provider is authoritative: it is where the money actually moved. Our
   * row is a cache of that, however carefully the webhooks were applied.
   *
   * Corrections respect the same out-of-order rule as webhook application —
   * a snapshot is only written if it is newer than the last event applied, so
   * reconciliation running concurrently with a webhook cannot undo it.
   */
  async reconcileSubscriptions(limit = 50): Promise<{ checked: number; corrected: number }> {
    const subscriptions = await prisma.subscription.findMany({
      where: {
        status: { in: ['INCOMPLETE', 'ACTIVE', 'PAST_DUE'] },
        providerSubscriptionId: { not: null },
      },
      take: limit,
      orderBy: [{ lastReconciledAt: { sort: 'asc', nulls: 'first' } }],
    });

    let corrected = 0;
    const now = new Date();

    for (const subscription of subscriptions) {
      const adapter = providerRegistry.find(subscription.provider);
      if (!adapter) continue;

      let snapshot;
      try {
        snapshot = await adapter.fetchSubscription(subscription.providerSubscriptionId!);
      } catch (err: any) {
        log.warn('Could not fetch subscription for reconciliation', {
          subscriptionId: subscription.id,
          error: err?.message,
        });
        continue;
      }

      if (!snapshot) {
        log.warn('Provider does not recognise a subscription we hold', {
          subscriptionId: subscription.id,
          providerSubscriptionId: subscription.providerSubscriptionId,
        });
        await prisma.subscription.update({
          where: { id: subscription.id },
          data: { lastReconciledAt: now },
        });
        continue;
      }

      const drifted =
        snapshot.status !== subscription.status ||
        snapshot.cancelAtPeriodEnd !== subscription.cancelAtPeriodEnd ||
        snapshot.currentPeriodEnd?.getTime() !== subscription.currentPeriodEnd?.getTime();

      if (!drifted) {
        await prisma.subscription.update({
          where: { id: subscription.id },
          data: { lastReconciledAt: now },
        });
        continue;
      }

      corrected += 1;
      log.warn('Correcting subscription drift from provider', {
        subscriptionId: subscription.id,
        ours: subscription.status,
        theirs: snapshot.status,
      });

      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          status: snapshot.status,
          currentPeriodStart: snapshot.currentPeriodStart,
          currentPeriodEnd: snapshot.currentPeriodEnd,
          cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
          providerCustomerRef: snapshot.providerCustomerRef,
          // Clear or start the grace window to match reality.
          pastDueSince:
            snapshot.status === 'PAST_DUE' ? (subscription.pastDueSince ?? now) : null,
          lastReconciledAt: now,
        },
      });
    }

    return { checked: subscriptions.length, corrected };
  },

  async run(): Promise<void> {
    if (!providerRegistry.isConfigured) {
      // Nothing to reconcile against. Says so once rather than looking healthy.
      log.debug('Reconciliation skipped — no payment provider configured');
      return;
    }

    await reconciliationService.retryUnconfirmedCancellations();
    await reconciliationService.reconcileSubscriptions();
  },
};
