import { createLogger } from '@/lib/logger';
import type { NormalisedEvent, NormalisedEventPayload } from '../payment.provider';

const log = createLogger('paystack-events');

/**
 * Paystack's vocabulary, translated into ours. The whole of it, in one file.
 *
 * Everything below reads a vendor's field names — `subscription_code`,
 * `plan_code`, `paid_at`, `email_token` — and nothing outside this folder ever
 * will. That is the entire point of the boundary: if Paystack renames a field
 * or we swap providers, the blast radius is this file.
 *
 * ── Three things Paystack does not give us ───────────────────────────────
 *
 * 1. *No event id.* A webhook body is `{ event, data }` and nothing more.
 *    There is no delivery id, no `evt_` handle, nothing that identifies this
 *    event as distinct from another of the same type. Our replay guarantee is
 *    a unique index on the event id, so one has to be derived — see
 *    `deriveEventId`, which is doing more work than it looks like.
 *
 * 2. *No event timestamp.* There is no top-level "when this happened". Each
 *    event type buries something usable in a different place, and one type
 *    buries something actively misleading — see `deriveOccurredAt`.
 *
 * 3. *No subscription on the first charge.* Paystack creates the subscription
 *    itself once a plan transaction succeeds, so the charge that starts a
 *    subscription does not carry its code. The link is made from the customer
 *    and plan instead, which is why both are lifted onto every event we emit.
 */

/** The envelope. Every webhook body has exactly this shape. */
interface PaystackWebhook {
  event?: string;
  data?: Record<string, any>;
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const asDate = (value: unknown): Date | undefined => {
  const raw = asString(value);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

/**
 * Metadata as we sent it at checkout, if it survived the round trip.
 *
 * Paystack returns an empty metadata field as the integer `0` rather than as
 * `null` or `{}`, and re-serialises a nested object as a JSON *string* in some
 * flows. Both are real and both would throw a naive property access.
 */
const readMetadata = (value: unknown): Record<string, unknown> => {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
};

/**
 * Paystack event name to ours.
 *
 * `null` means "signed, understood, and not something we act on" — intake
 * acknowledges it and stores nothing. Two entries are functions because the
 * event name alone does not determine what happened: an invoice update is a
 * renewal or a failed renewal depending on its body.
 */
type Translation = string | null | ((data: Record<string, any>) => string | null);

const EVENT_TYPES: Record<string, Translation> = {
  // Money in. On the first charge of a plan this is also what causes Paystack
  // to create the subscription — but it does not carry its code.
  'charge.success': 'charge.succeeded',
  'charge.failed': 'charge.failed',

  // Money back out. Paystack calls a refund a refund, not a charge; we file
  // it against the charge it reverses.
  'refund.processed': 'charge.refunded',
  // Announced, then reversed. Nothing has moved, so nothing is recorded.
  'refund.pending': null,
  'refund.failed': null,

  'subscription.create': 'subscription.activated',
  // Paystack disables a subscription both when it is cancelled and when a
  // fixed-length one runs out. `status` tells them apart.
  'subscription.disable': (data) =>
    data?.status === 'complete' ? 'subscription.expired' : 'subscription.cancelled',
  // Renewal switched off, current period still paid for. Not a cancellation
  // yet — the difference matters, because entitlement must not end early.
  'subscription.not_renew': 'subscription.cancel_scheduled',
  'subscription.expiring_cards': null,

  // The renewal cycle. `invoice.create` fires days ahead of the charge and
  // says only that one is coming.
  'invoice.create': null,
  'invoice.update': (data) =>
    data?.paid === true || data?.status === 'success'
      ? 'subscription.renewed'
      : 'subscription.payment_failed',
  'invoice.payment_failed': 'subscription.payment_failed',

  // Disputes are handled by a human in the Paystack dashboard, not by us.
  'charge.dispute.create': null,
  'charge.dispute.remind': null,
  'charge.dispute.resolve': null,

  // Payouts to us. Nothing to do with a subscriber's entitlement.
  'transfer.success': null,
  'transfer.failed': null,
  'transfer.reversed': null,
};

/**
 * An id that is the same for every redelivery of one event and different for
 * every other event.
 *
 * Both halves matter and they pull against each other. Too specific — hashing
 * the body — and a redelivery with a recalculated field becomes a new event,
 * so it applies twice. Too general — the subscription code alone — and two
 * genuinely different events collide, so the second is silently dropped as a
 * duplicate.
 *
 * So each type is keyed on the most specific thing Paystack holds *fixed* for
 * that event: a transaction id, an invoice code plus its outcome, a
 * subscription code plus the transition. Where a type could legitimately
 * recur for the same subject — a renewal invoice each month — the key includes
 * something that moves with the occurrence.
 */
const deriveEventId = (event: string, data: Record<string, any>): string => {
  switch (event) {
    case 'charge.success':
    case 'charge.failed':
      // The transaction id is Paystack's own primary key and never moves.
      return `${event}:${data.id ?? data.reference}`;

    case 'refund.processed':
      return `${event}:${data.refund_reference ?? data.id ?? data.transaction_reference}`;

    case 'invoice.update':
    case 'invoice.payment_failed':
      // One invoice can update more than once — created, charged, failed,
      // retried. The outcome is part of the identity, or a retry that finally
      // succeeds would be dropped as a replay of the failure.
      return `${event}:${data.invoice_code ?? data.id}:${data.status ?? 'unknown'}`;

    case 'subscription.create':
    case 'subscription.disable':
    case 'subscription.not_renew':
      // Each of these happens at most once per subscription, so the code plus
      // the transition is enough — and stays stable across redeliveries,
      // which a timestamp would not.
      return `${event}:${data.subscription_code}`;

    default:
      return `${event}:${data.id ?? data.reference ?? data.subscription_code ?? 'unknown'}`;
  }
};

/**
 * When Paystack says it happened.
 *
 * Out-of-order protection compares this against the last timestamp applied to
 * a subscription, so a wrong value here does real damage: too early and a
 * genuine event is discarded as stale.
 *
 * The trap is `subscription.disable`. Its `created_at` is the date the
 * *subscription* was created, not the date it was disabled — often months
 * earlier. Reading it would make every cancellation look older than the
 * activation that preceded it, and every cancellation would be dropped. So
 * those events are stamped at receipt instead: arrival time is a worse signal
 * than a real event time, and an enormously better one than a wrong one.
 */
const deriveOccurredAt = (event: string, data: Record<string, any>): Date => {
  switch (event) {
    case 'charge.success':
    case 'charge.failed':
      return asDate(data.paid_at) ?? asDate(data.created_at) ?? new Date();

    case 'invoice.update':
    case 'invoice.payment_failed':
      return asDate(data.updated_at) ?? asDate(data.paid_at) ?? asDate(data.created_at) ?? new Date();

    case 'refund.processed':
      return asDate(data.updated_at) ?? asDate(data.created_at) ?? new Date();

    case 'subscription.create':
      // Here `created_at` really is the moment the subscription came into
      // being, which is the moment this event describes.
      return asDate(data.created_at) ?? asDate(data.createdAt) ?? new Date();

    default:
      // Including subscription.disable and subscription.not_renew, whose
      // timestamps describe the subscription rather than the event.
      return new Date();
  }
};

/** Pull the subscription code out of wherever this event type keeps it. */
const subscriptionCode = (data: Record<string, any>): string | undefined =>
  asString(data.subscription_code) ?? asString(data.subscription?.subscription_code);

/** Likewise the token Paystack demands alongside the code before it will cancel. */
const emailToken = (data: Record<string, any>): string | undefined =>
  asString(data.email_token) ?? asString(data.subscription?.email_token);

const planCode = (data: Record<string, any>): string | undefined =>
  asString(data.plan?.plan_code) ?? asString(data.plan_code);

const period = (event: string, data: Record<string, any>) => {
  // An invoice is the one payload that states a period outright.
  if (event.startsWith('invoice.')) {
    return {
      start: asDate(data.period_start),
      end: asDate(data.period_end) ?? asDate(data.subscription?.next_payment_date),
    };
  }

  // Everywhere else it has to be inferred. Paystack publishes when the next
  // charge falls due and never when the current period began, so the start is
  // only knowable for the first period, where it is the creation date.
  return {
    start: event === 'subscription.create' ? asDate(data.created_at) : undefined,
    end: asDate(data.next_payment_date) ?? asDate(data.subscription?.next_payment_date),
  };
};

/** The reference the money moved under, by which a refund finds its charge. */
const paymentReference = (event: string, data: Record<string, any>): string | undefined => {
  if (event === 'refund.processed') {
    return (
      asString(data.refund_reference) ??
      (asString(data.transaction_reference)
        ? `refund:${data.transaction_reference}`
        : undefined)
    );
  }
  return asString(data.reference) ?? asString(data.transaction?.reference);
};

export const parsePaystackEvent = (rawBody: Buffer): NormalisedEvent | null => {
  let body: PaystackWebhook;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as PaystackWebhook;
  } catch {
    throw new Error('body is not valid JSON');
  }

  const event = asString(body?.event);
  const data = body?.data;

  if (!event || !data || typeof data !== 'object') {
    throw new Error('body is not a Paystack webhook envelope');
  }

  if (!(event in EVENT_TYPES)) {
    // Paystack adds event types without asking. An unrecognised one is
    // acknowledged and dropped rather than failed, because failing would make
    // Paystack retry something we will never understand.
    log.info('Unrecognised Paystack event acknowledged and dropped', { event });
    return null;
  }

  const translation = EVENT_TYPES[event];
  const type = typeof translation === 'function' ? translation(data) : translation;
  if (!type) return null;

  const metadata = readMetadata(data.metadata);
  const { start, end } = period(event, data);
  const token = emailToken(data);

  const payload: NormalisedEventPayload = {
    providerSubscriptionId: subscriptionCode(data),
    providerCustomerRef: asString(data.customer?.customer_code),
    providerReference: paymentReference(event, data),
    providerPriceId: planCode(data),
    // The only strong link on a first charge: our own subscription id, sent
    // out at checkout and handed back untouched.
    localSubscriptionId: asString(metadata.subscriptionId),
    currentPeriodStart: start?.toISOString(),
    currentPeriodEnd: end?.toISOString(),
    amountMinor: typeof data.amount === 'number' ? data.amount : undefined,
    currency: asString(data.currency),
    // "Renewal off, still paid up" is the one state Paystack expresses as its
    // own event rather than as a status.
    cancelAtPeriodEnd: type === 'subscription.cancel_scheduled' ? true : undefined,
    // Opaque outside this folder. Captured wherever it appears because the
    // event that grants it is not always the event that needs it.
    providerMetadata: token ? { emailToken: token } : undefined,
  };

  return {
    providerEventId: deriveEventId(event, data),
    type,
    occurredAt: deriveOccurredAt(event, data),
    payload: payload as Record<string, unknown>,
  };
};
