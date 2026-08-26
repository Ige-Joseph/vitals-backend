import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import type { NormalisedEventPayload } from './provider/payment.provider';

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
 *
 * A third problem shows up once a real provider is attached: *which
 * subscription is this about*. Not every provider lets us create a
 * subscription and hand it an id. Some create it themselves once a payment
 * clears, which means the first event about a subscription arrives carrying an
 * identifier we have never seen. See `resolve`.
 */

/** Event types we act on. Anything else is recorded and ignored. */
const SUBSCRIPTION_EVENTS = new Set([
  'subscription.activated',
  'subscription.renewed',
  'subscription.payment_failed',
  'subscription.cancelled',
  'subscription.cancel_scheduled',
  'subscription.expired',
]);

const PAYMENT_EVENTS = new Set(['charge.succeeded', 'charge.failed', 'charge.refunded']);

type EventPayload = NormalisedEventPayload;

/**
 * The status each event puts a subscription into.
 *
 * `subscription.cancel_scheduled` is deliberately absent: renewal being
 * switched off does not change what someone is entitled to today. They paid
 * for a period and they keep it. Only `cancelAtPeriodEnd` moves.
 */
const STATUS_FOR: Record<string, 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'EXPIRED' | undefined> = {
  'subscription.activated': 'ACTIVE',
  'subscription.renewed': 'ACTIVE',
  'subscription.payment_failed': 'PAST_DUE',
  'subscription.cancelled': 'CANCELED',
  'subscription.expired': 'EXPIRED',
  'subscription.cancel_scheduled': undefined,
};

const MONTHS_PER_INTERVAL: Record<string, number> = { month: 1, year: 12 };

/** Where a period that starts now would end, per the price that was bought. */
const periodEndFrom = (
  start: Date,
  price: { interval: string; intervalCount: number },
): Date => {
  const months = (MONTHS_PER_INTERVAL[price.interval] ?? 1) * price.intervalCount;
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + months);
  return end;
};

/**
 * Add to what the adapter already holds rather than replacing it.
 *
 * The handle an adapter needs is not always on the event that needs it, so
 * every event carrying one contributes.
 */
const mergeMetadata = (
  existing: unknown,
  incoming: Record<string, unknown>,
): Prisma.InputJsonObject =>
  ({
    ...((existing as Record<string, unknown> | null) ?? {}),
    ...incoming,
  }) as Prisma.InputJsonObject;

interface Resolved {
  subscription: { id: string; providerSubscriptionId: string | null };
  /** The provider has named this subscription and we had not recorded the name. */
  claiming: boolean;
}

export const eventApplier = {
  /**
   * Which of our subscriptions an event is about.
   *
   * Three routes, strongest first, because a provider that creates the
   * subscription on our behalf gives us a different link at each stage:
   *
   *   1. Its own subscription id. Unique here, so this is exact — and it is
   *      how every event after the first one resolves.
   *
   *   2. Our id, sent out in checkout metadata and handed back untouched. This
   *      is what the *first charge* carries, before any subscription exists.
   *
   *   3. The customer and the price. The last resort, and the one that catches
   *      the event announcing a subscription the provider just invented: it
   *      carries neither our id nor an id we know, but it does say who is
   *      paying and for what.
   *
   * Route 3 is narrowed to rows still waiting to be claimed — no provider id
   * yet — so a subscriber who cancels and re-subscribes to the same price
   * cannot have the new subscription attached to the old row. It allows ACTIVE
   * as well as INCOMPLETE because a first charge can arrive, and activate the
   * row, before the provider gets round to naming the subscription.
   */
  async resolve(payload: EventPayload): Promise<Resolved | null> {
    const claiming = (row: { providerSubscriptionId: string | null }) =>
      !row.providerSubscriptionId && Boolean(payload.providerSubscriptionId);

    if (payload.providerSubscriptionId) {
      const known = await prisma.subscription.findUnique({
        where: { providerSubscriptionId: payload.providerSubscriptionId },
        select: { id: true, providerSubscriptionId: true },
      });
      if (known) return { subscription: known, claiming: false };
    }

    if (payload.localSubscriptionId) {
      const ours = await prisma.subscription.findUnique({
        where: { id: payload.localSubscriptionId },
        select: { id: true, providerSubscriptionId: true },
      });
      if (ours) return { subscription: ours, claiming: claiming(ours) };
    }

    if (payload.providerCustomerRef && payload.providerPriceId) {
      const price = await prisma.price.findFirst({
        where: { providerPriceId: payload.providerPriceId },
        select: { id: true },
      });

      if (price) {
        const waiting = await prisma.subscription.findFirst({
          where: {
            providerCustomerRef: payload.providerCustomerRef,
            priceId: price.id,
            providerSubscriptionId: null,
            status: { in: ['INCOMPLETE', 'ACTIVE'] },
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true, providerSubscriptionId: true },
        });
        if (waiting) return { subscription: waiting, claiming: claiming(waiting) };
      }
    }

    return null;
  },

  async apply(webhookEventId: string): Promise<'applied' | 'ignored'> {
    const event = await prisma.billingWebhookEvent.findUniqueOrThrow({
      where: { id: webhookEventId },
    });

    if (event.status === 'PROCESSED') {
      // Already done — a queue retry after a successful run.
      return 'ignored';
    }

    if (event.status === 'DEAD_LETTERED') {
      // Retries are exhausted and a person has to look at it. Automatic
      // reprocessing here would hide exactly the thing dead-lettering exists
      // to expose.
      log.warn('Refusing to apply a dead-lettered event', {
        webhookEventId,
        providerEventId: event.providerEventId,
      });
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
    const resolved = await eventApplier.resolve(payload);

    if (!resolved) {
      log.warn('Event for an unknown subscription', {
        providerSubscriptionId: payload.providerSubscriptionId,
        type: event.type,
      });
      return 'ignored';
    }

    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { id: resolved.subscription.id },
    });

    // Out-of-order guard. An event no newer than what we have already applied
    // tells us nothing about state, and applying it would move state backwards.
    const stale = Boolean(
      subscription.providerUpdatedAt && event.occurredAt <= subscription.providerUpdatedAt,
    );

    // With one exception, and it is not a loophole. A claim carries the
    // provider's name for this subscription, which nothing else can supply and
    // which no later event will repeat — without it we could never cancel or
    // reconcile the row. That name is a fact about identity, not about state,
    // so it is recorded even from an event too old to be believed about
    // anything else. This is a live case, not a theoretical one: a provider
    // that creates a subscription off the back of a charge stamps both within
    // the same second, and a first charge that has already activated the row
    // makes the announcement that follows it look stale.
    if (stale && !resolved.claiming) {
      log.info('Stale event ignored', {
        subscriptionId: subscription.id,
        type: event.type,
        occurredAt: event.occurredAt,
        alreadyAppliedThrough: subscription.providerUpdatedAt,
      });
      return 'ignored';
    }

    if (resolved.claiming) {
      log.info('Claiming a subscription the provider named', {
        subscriptionId: subscription.id,
        providerSubscriptionId: payload.providerSubscriptionId,
        staleForState: stale,
      });
    }

    if (stale) {
      // Identity only. Everything this event says about status and periods is
      // older than what we already hold.
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          providerSubscriptionId: payload.providerSubscriptionId,
          ...(payload.providerMetadata
            ? {
                providerMetadata: mergeMetadata(
                  subscription.providerMetadata,
                  payload.providerMetadata,
                ),
              }
            : {}),
        },
      });
      return 'applied';
    }

    const status = STATUS_FOR[event.type];

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        ...(status ? { status } : {}),
        providerUpdatedAt: event.occurredAt,

        // The provider has told us what it calls this subscription. Written
        // once, on the first event that carries it — without this, nothing
        // could ever cancel or reconcile it.
        ...(resolved.claiming
          ? { providerSubscriptionId: payload.providerSubscriptionId }
          : {}),

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

        ...(payload.providerMetadata
          ? {
              providerMetadata: mergeMetadata(
                subscription.providerMetadata,
                payload.providerMetadata,
              ),
            }
          : {}),

        // The grace window starts at the failed charge and is cleared the
        // moment a payment succeeds — otherwise a recovered subscription would
        // stay bounded by a window that no longer applies.
        ...(status
          ? {
              pastDueSince:
                status === 'PAST_DUE'
                  ? (subscription.pastDueSince ?? event.occurredAt)
                  : null,
            }
          : {}),

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
      status: status ?? subscription.status,
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

    const resolved = await eventApplier.resolve(payload);

    const subscription = resolved
      ? await prisma.subscription.findUniqueOrThrow({
          where: { id: resolved.subscription.id },
          select: {
            id: true,
            userId: true,
            status: true,
            currentPeriodEnd: true,
            providerUpdatedAt: true,
            user: { select: { erasedAt: true } },
            price: { select: { interval: true, intervalCount: true } },
          },
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

    // A successful charge against a subscription still waiting to start is
    // enough on its own. The provider will normally follow it with an event
    // announcing the subscription, but "normally" is not a guarantee, and a
    // dropped delivery must not leave someone who has paid without what they
    // paid for. Nothing here claims a provider id — that stays with the event
    // that carries one.
    if (
      subscription &&
      event.type === 'charge.succeeded' &&
      subscription.status === 'INCOMPLETE'
    ) {
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          status: 'ACTIVE',
          providerUpdatedAt: event.occurredAt,
          currentPeriodStart: event.occurredAt,
          // Derived from the price rather than from the provider, which has
          // not told us yet. A later event carrying a real period end
          // overwrites this.
          currentPeriodEnd: periodEndFrom(event.occurredAt, subscription.price),
          ...(payload.providerCustomerRef
            ? { providerCustomerRef: payload.providerCustomerRef }
            : {}),
        },
      });

      log.info('Subscription activated by its first successful charge', {
        subscriptionId: subscription.id,
      });
    }

    return 'applied';
  },
};
