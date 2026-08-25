import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';

const log = createLogger('billing-event-applier');

/**
 * Turning a recorded event into subscription state.
 *
 * Two things guard this, and they are different problems:
 *
 *   *Replay* is handled at intake, by the unique provider event id — the same
 *   event arriving twice.
 *
 *   *Out of order* is handled here, by comparing the provider's timestamp
 *   against the last one applied. Providers do not guarantee delivery order,
 *   and retries make it worse: a "renewed" event delayed by a minute can land
 *   after the "cancelled" that followed it. Arrival order says nothing, so it
 *   is never consulted.
 */

/** Event types we act on. Anything else is recorded and ignored. */
const SUBSCRIPTION_EVENTS = new Set([
  'subscription.activated',
  'subscription.renewed',
  'subscription.payment_failed',
  'subscription.cancelled',
  'subscription.expired',
]);

const PAYMENT_EVENTS = new Set(['charge.succeeded', 'charge.failed', 'charge.refunded']);

interface EventPayload {
  providerSubscriptionId?: string;
  providerCustomerRef?: string;
  providerReference?: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  amountMinor?: number;
  currency?: string;
  cancelAtPeriodEnd?: boolean;
}

const STATUS_FOR: Record<string, 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'EXPIRED'> = {
  'subscription.activated': 'ACTIVE',
  'subscription.renewed': 'ACTIVE',
  'subscription.payment_failed': 'PAST_DUE',
  'subscription.cancelled': 'CANCELED',
  'subscription.expired': 'EXPIRED',
};

export const eventApplier = {
  async apply(webhookEventId: string): Promise<'applied' | 'ignored'> {
    const event = await prisma.billingWebhookEvent.findUniqueOrThrow({
      where: { id: webhookEventId },
    });

    if (event.status === 'PROCESSED') {
      // Already done — a queue retry after a successful run.
      return 'ignored';
    }

    const payload = (event.payload ?? {}) as EventPayload;

    const outcome = SUBSCRIPTION_EVENTS.has(event.type)
      ? await eventApplier.applySubscriptionEvent(event, payload)
      : PAYMENT_EVENTS.has(event.type)
        ? await eventApplier.applyPaymentEvent(event, payload)
        : 'ignored';

    await prisma.billingWebhookEvent.update({
      where: { id: event.id },
      data: {
        status: outcome === 'applied' ? 'PROCESSED' : 'IGNORED',
        processedAt: new Date(),
      },
    });

    return outcome;
  },

  async applySubscriptionEvent(
    event: { id: string; type: string; occurredAt: Date; provider: any },
    payload: EventPayload,
  ): Promise<'applied' | 'ignored'> {
    if (!payload.providerSubscriptionId) return 'ignored';

    const subscription = await prisma.subscription.findUnique({
      where: { providerSubscriptionId: payload.providerSubscriptionId },
    });

    if (!subscription) {
      log.warn('Event for an unknown subscription', {
        providerSubscriptionId: payload.providerSubscriptionId,
        type: event.type,
      });
      return 'ignored';
    }

    // Out-of-order guard. An event no newer than what we have already applied
    // tells us nothing, and applying it would move state backwards.
    if (
      subscription.providerUpdatedAt &&
      event.occurredAt <= subscription.providerUpdatedAt
    ) {
      log.info('Stale event ignored', {
        subscriptionId: subscription.id,
        type: event.type,
        occurredAt: event.occurredAt,
        alreadyAppliedThrough: subscription.providerUpdatedAt,
      });
      return 'ignored';
    }

    const status = STATUS_FOR[event.type];

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status,
        providerUpdatedAt: event.occurredAt,
        ...(payload.providerCustomerRef
          ? { providerCustomerRef: payload.providerCustomerRef }
          : {}),
        ...(payload.currentPeriodStart
          ? { currentPeriodStart: new Date(payload.currentPeriodStart) }
          : {}),
        ...(payload.currentPeriodEnd
          ? { currentPeriodEnd: new Date(payload.currentPeriodEnd) }
          : {}),
        ...(payload.cancelAtPeriodEnd !== undefined
          ? { cancelAtPeriodEnd: payload.cancelAtPeriodEnd }
          : {}),

        // The grace window starts at the failed charge and is cleared the
        // moment a payment succeeds — otherwise a recovered subscription would
        // stay bounded by a window that no longer applies.
        pastDueSince:
          status === 'PAST_DUE'
            ? (subscription.pastDueSince ?? event.occurredAt)
            : null,

        ...(status === 'CANCELED' ? { canceledAt: event.occurredAt } : {}),
        ...(status === 'EXPIRED' ? { endedAt: event.occurredAt } : {}),

        // A cancellation we asked for is now confirmed by the provider,
        // which is what stops reconciliation retrying it.
        ...(status === 'CANCELED' && subscription.cancellationRequestedAt
          ? { cancellationConfirmedAt: event.occurredAt }
          : {}),
      },
    });

    log.info('Subscription event applied', {
      subscriptionId: subscription.id,
      type: event.type,
      status,
    });

    return 'applied';
  },

  /**
   * Money movements.
   *
   * The subscription link is optional and the user link is set from it rather
   * than required, because a refund can arrive after the account was erased —
   * at which point there is no user to attach and the row still has to land.
   */
  async applyPaymentEvent(
    event: { type: string; occurredAt: Date; provider: any },
    payload: EventPayload,
  ): Promise<'applied' | 'ignored'> {
    if (!payload.providerReference) return 'ignored';

    const subscription = payload.providerSubscriptionId
      ? await prisma.subscription.findUnique({
          where: { providerSubscriptionId: payload.providerSubscriptionId },
          select: { id: true, userId: true, user: { select: { erasedAt: true } } },
        })
      : null;

    // An erased account keeps no personal link. The provider's own references
    // are what a late refund is matched on.
    const userId =
      subscription && !subscription.user.erasedAt ? subscription.userId : null;

    const type =
      event.type === 'charge.refunded'
        ? 'REFUND'
        : ('CHARGE' as const);

    await prisma.paymentTransaction.createMany({
      data: [
        {
          userId,
          subscriptionId: subscription?.id ?? null,
          provider: event.provider,
          providerReference: payload.providerReference,
          providerCustomerRef: payload.providerCustomerRef ?? null,
          type,
          status: event.type === 'charge.failed' ? 'FAILED' : 'SUCCEEDED',
          amountMinor: payload.amountMinor ?? 0,
          currency: payload.currency ?? 'NGN',
          payload: payload as any,
          occurredAt: event.occurredAt,
        },
      ],
      // Belt and braces: intake already rejects a replayed event, and the
      // unique provider reference stops a differently-identified event from
      // booking the same money twice.
      skipDuplicates: true,
    });

    return 'applied';
  },
};
