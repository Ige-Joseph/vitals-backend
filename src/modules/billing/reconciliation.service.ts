import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { createLogger } from '@/lib/logger';
import { billingQueue, JOB_NAMES } from '@/queues/queue.registry';
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
 * It does three jobs, and the second is the most important: retrying the
 * cancellations that erasure and deactivation recorded but could not confirm.
 * Those are accounts that no longer exist still being billed, which is the
 * worst failure this system can produce.
 */

/**
 * How long after arrival an unprocessed event is considered stalled.
 *
 * Processing normally takes seconds. Fifteen minutes is long enough that a
 * slow retry backoff is not mistaken for a lost job, and short enough that a
 * queue wiped by a deploy is picked up within the hour.
 */
const STALLED_AFTER_MS = 15 * 60_000;
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
      const result = await providerRegistry.tryCancel(subscription, 'reconciliation-retry');

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
   * Deal with events that stopped moving.
   *
   * Two different failures look the same from the database and need opposite
   * treatment, so this separates them by attempt count:
   *
   *   *Retries left.* The row says PENDING or FAILED and nothing is coming
   *   back for it — the queue job was lost, which is what a Redis flush or a
   *   deploy mid-retry does. Re-driven. The job id is derived from the event
   *   id, so re-adding one that does still exist is a no-op rather than a
   *   double application.
   *
   *   *Retries exhausted.* Dead-lettered: kept, shouted about, and never
   *   retried automatically again. An event that has failed five times will
   *   fail a sixth, and quietly re-driving it forever is how a billing bug
   *   turns into a billing bug nobody knows about.
   */
  async sweepStalledEvents(): Promise<{
    redriven: number;
    deadLettered: number;
    deadLetterBacklog: number;
  }> {
    const stalledBefore = new Date(Date.now() - STALLED_AFTER_MS);

    // Exhausted first, so the re-drive below cannot pick up something that
    // should have been dead-lettered in the same pass.
    const exhausted = await prisma.billingWebhookEvent.findMany({
      where: {
        status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
        retryCount: { gte: env.BILLING_EVENT_MAX_ATTEMPTS },
      },
      take: 200,
      select: { id: true, provider: true, providerEventId: true, type: true, error: true },
    });

    if (exhausted.length > 0) {
      await prisma.billingWebhookEvent.updateMany({
        where: { id: { in: exhausted.map((e) => e.id) } },
        data: { status: 'DEAD_LETTERED' },
      });

      for (const event of exhausted) {
        log.error('BILLING EVENT DEAD-LETTERED — needs a human', {
          webhookEventId: event.id,
          provider: event.provider,
          providerEventId: event.providerEventId,
          type: event.type,
          error: event.error,
        });
      }
    }

    const stalled = await prisma.billingWebhookEvent.findMany({
      where: {
        status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
        retryCount: { lt: env.BILLING_EVENT_MAX_ATTEMPTS },
        receivedAt: { lt: stalledBefore },
      },
      take: 200,
      orderBy: { receivedAt: 'asc' },
      select: { id: true, retryCount: true },
    });

    for (const event of stalled) {
      await billingQueue.add(
        JOB_NAMES.PROCESS_BILLING_EVENT,
        { webhookEventId: event.id },
        {
          jobId: `billing-event-${event.id}`,
          // What is left of the budget, so re-driving cannot hand an event a
          // fresh set of attempts every hour and keep it out of the dead
          // letter queue indefinitely.
          attempts: Math.max(1, env.BILLING_EVENT_MAX_ATTEMPTS - event.retryCount),
          backoff: { type: 'exponential', delay: 5000 },
        },
      );
    }

    if (stalled.length > 0) {
      log.warn('Re-drove billing events whose queue jobs had gone', {
        count: stalled.length,
      });
    }

    // The standing total, not just this pass's additions. A backlog that is
    // not going down is the thing worth seeing, and it only shows up if the
    // whole of it is reported every time.
    const deadLetterBacklog = await prisma.billingWebhookEvent.count({
      where: { status: 'DEAD_LETTERED' },
    });

    if (deadLetterBacklog > 0) {
      log.error('Billing events are sitting dead-lettered', { count: deadLetterBacklog });
    }

    return {
      redriven: stalled.length,
      deadLettered: exhausted.length,
      deadLetterBacklog,
    };
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
    // Sweeping runs whether or not a provider is configured: a stuck event is
    // stuck in our own database, and it does not stop being stuck because the
    // key was removed from the environment.
    await reconciliationService.sweepStalledEvents();

    if (!providerRegistry.isConfigured) {
      // Nothing to reconcile against. Says so once rather than looking healthy.
      log.debug('Reconciliation skipped — no payment provider configured');
      return;
    }

    await reconciliationService.retryUnconfirmedCancellations();
    await reconciliationService.reconcileSubscriptions();
  },
};
