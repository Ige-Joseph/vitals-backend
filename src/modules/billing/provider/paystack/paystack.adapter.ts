import crypto from 'crypto';

import { createLogger } from '@/lib/logger';
import type {
  PaymentProviderAdapter,
  CheckoutRequest,
  CheckoutSession,
  CancelRequest,
  CancelResult,
  ProviderSubscriptionSnapshot,
  NormalisedEvent,
} from '../payment.provider';
import { createPaystackApi, PaystackError, type PaystackApi } from './paystack.api';
import { parsePaystackEvent } from './paystack.events';

const log = createLogger('paystack-adapter');

/**
 * Paystack.
 *
 * Recurring billing is Paystack's Plans feature rather than a renewal loop of
 * our own: the provider holds the card, decides when to charge, retries a
 * failure on its own schedule and tells us what happened. Writing that
 * ourselves would mean storing an authorisation, running a scheduler against
 * it, and being the one who charges a card at the wrong moment.
 *
 * ── Where Paystack does not fit the interface ────────────────────────────
 *
 * The interface was written against a Stripe-shaped world. Paystack differs in
 * ways that are handled here and are worth knowing about:
 *
 *   *We cannot create a subscription.* There is no "create subscription with
 *   this card" call in the checkout flow. Paystack creates it itself the first
 *   time a plan transaction succeeds, and only then does it have a code. So
 *   `createCheckout` returns without a subscription id, our row waits in
 *   INCOMPLETE, and `subscription.create` claims it — matched on the customer
 *   and plan, which is why the customer is created up front rather than left
 *   to be implied by the payment.
 *
 *   *Cancelling needs two secrets.* `POST /subscription/disable` wants the
 *   subscription code and an `email_token`, and the token is not always on the
 *   event that announced the subscription. It is captured from any event that
 *   carries it and fetched on demand when it was never seen.
 *
 *   *There is no cancel-at-period-end.* Disabling stops future charges; the
 *   subscriber keeps the period already paid for. `immediate` therefore
 *   changes what *we* record, not what Paystack does.
 *
 *   *Intervals are a fixed vocabulary.* Paystack has `monthly` and `annually`,
 *   not "every N months". A period it cannot express cannot be sold.
 */

/** Paystack's interval names, keyed by ours. Anything absent is unsellable. */
const INTERVALS: Record<string, string> = {
  'month:1': 'monthly',
  'month:3': 'quarterly',
  'month:6': 'biannually',
  'year:1': 'annually',
};

/** Paystack's subscription statuses, in ours. */
const STATUSES: Record<string, ProviderSubscriptionSnapshot['status']> = {
  active: 'ACTIVE',
  // Renewal switched off, current period still running and still paid for.
  // Not CANCELED: entitlement must survive to the end of what was bought.
  'non-renewing': 'ACTIVE',
  // Paystack's word for "a charge failed and we are retrying".
  attention: 'PAST_DUE',
  completed: 'EXPIRED',
  complete: 'EXPIRED',
  cancelled: 'CANCELED',
  canceled: 'CANCELED',
};

interface PaystackPlan {
  plan_code: string;
  name: string;
  description: string | null;
  amount: number;
  interval: string;
  currency: string;
}

interface PaystackCustomer {
  customer_code: string;
  email: string;
}

interface PaystackSubscription {
  subscription_code: string;
  email_token: string | null;
  status: string;
  next_payment_date: string | null;
  createdAt?: string;
  created_at?: string;
  customer?: { customer_code?: string };
}

/**
 * The marker that makes a plan ours.
 *
 * Paystack has no way to look a plan up by anything but its own code, so
 * finding one we created earlier means listing plans and recognising it. The
 * price id goes in the description rather than the name because the name is
 * shown to the payer on receipts and in Paystack's own emails.
 */
const MARKER = 'vitals-price:';

export const createPaystackAdapter = (secretKey: string): PaymentProviderAdapter => {
  const api: PaystackApi = createPaystackApi(secretKey);

  /** Find or create the payer, so we hold their handle before they pay. */
  const ensureCustomer = async (email: string): Promise<string | null> => {
    try {
      // Paystack treats this as an upsert on the email: an existing customer
      // comes back rather than erroring, which is what makes it safe to call
      // on every checkout.
      const customer = await api.post<PaystackCustomer>('/customer', { email });
      return customer.customer_code ?? null;
    } catch (err) {
      // Not fatal. Checkout can proceed on the email alone; we lose the
      // strongest link for claiming the eventual subscription and fall back to
      // the id we pass through metadata.
      log.warn('Could not resolve a Paystack customer before checkout', {
        error: (err as Error).message,
      });
      return null;
    }
  };

  const findPlanByMarker = async (priceId: string): Promise<string | null> => {
    // No search endpoint, so: list and recognise. Two pages of 100 is far more
    // than a price list should ever reach, and running out is better than
    // paging forever against a provider during a checkout.
    for (const page of [1, 2]) {
      const plans = await api.get<PaystackPlan[]>('/plan', { perPage: 100, page });
      const match = plans.find((plan) => plan.description?.includes(`${MARKER}${priceId}`));
      if (match) return match.plan_code;
      if (plans.length < 100) break;
    }
    return null;
  };

  return {
    name: 'PAYSTACK',

    parseEvent(rawBody: Buffer): NormalisedEvent | null {
      return parsePaystackEvent(rawBody);
    },

    async ensurePlan(price): Promise<string> {
      const interval = INTERVALS[`${price.interval}:${price.intervalCount}`];
      if (!interval) {
        // Refuse rather than silently selling the wrong period. Paystack has a
        // closed set of intervals and "every 2 months" is not in it.
        throw new Error(
          `Paystack cannot bill every ${price.intervalCount} ${price.interval}(s). ` +
            `Supported: ${Object.keys(INTERVALS).join(', ')}.`,
        );
      }

      const existing = await findPlanByMarker(price.id);
      if (existing) return existing;

      const plan = await api.post<PaystackPlan>('/plan', {
        name: `Vitals Premium — ${price.label}`,
        amount: price.amountMinor,
        interval,
        currency: price.currency,
        // How this plan is found again, and the whole of why a repricing is
        // safe: a new price id creates a new plan, and everyone already on the
        // old plan keeps being charged the old amount by Paystack itself.
        description: `${MARKER}${price.id}`,
        send_invoices: true,
        send_sms: false,
      });

      log.info('Paystack plan created', { priceId: price.id, planCode: plan.plan_code });
      return plan.plan_code;
    },

    async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
      const customerCode = await ensureCustomer(request.customer.email);

      // Ours, not Paystack's, so the transaction is identifiable before the
      // provider has answered. The attempt is in it because Paystack rejects a
      // reference it has seen before, and a payer who abandons a checkout and
      // comes back is on the same subscription row.
      const reference = `vitals-${request.subscriptionId}-${request.attempt}`;

      const initialised = await api.post<{
        authorization_url: string;
        reference: string;
        access_code: string;
      }>('/transaction/initialize', {
        email: request.customer.email,
        amount: request.amountMinor,
        currency: request.currency,
        // The plan is what turns a one-off payment into a subscription.
        // Paystack charges this amount now and takes over the schedule after.
        plan: request.providerPlanId,
        reference,
        callback_url: request.returnUrl,
        metadata: {
          ...request.metadata,
          // Shown to us in the Paystack dashboard, where a support question
          // starts with "which of these is that account".
          custom_fields: [
            {
              display_name: 'Vitals subscription',
              variable_name: 'vitals_subscription_id',
              value: request.subscriptionId,
            },
          ],
        },
      });

      log.info('Paystack checkout initialised', {
        subscriptionId: request.subscriptionId,
        reference: initialised.reference,
      });

      return {
        redirectUrl: initialised.authorization_url,
        providerReference: initialised.reference,
        providerCustomerRef: customerCode,
        providerMetadata: { checkoutReference: initialised.reference },
      };
    },

    async cancelSubscription(request: CancelRequest): Promise<CancelResult> {
      const code = request.providerSubscriptionId;

      // Paystack will not disable on the code alone. The token usually arrives
      // on an event and is kept; when it did not, it has to be fetched, and
      // failing to fetch it is itself an answer about whether the
      // subscription still exists.
      let token = (request.providerMetadata?.emailToken as string | undefined) ?? undefined;

      if (!token) {
        try {
          const fetched = await api.get<PaystackSubscription>(`/subscription/${code}`);
          token = fetched.email_token ?? undefined;

          const mapped = STATUSES[fetched.status];
          if (mapped === 'CANCELED' || mapped === 'EXPIRED') {
            // Already off. Confirmed rather than retried forever.
            return { confirmed: true, detail: `already ${fetched.status}` };
          }
        } catch (err) {
          const paystackErr = err as PaystackError;
          if (paystackErr.answered && /not found|cannot be found/i.test(paystackErr.message)) {
            // Paystack does not have it, so nothing can be charging against
            // it. Confirmed — the point of cancelling is that no money moves.
            return { confirmed: true, detail: 'unknown to provider' };
          }
          return { confirmed: false, detail: paystackErr.message };
        }
      }

      if (!token) {
        return { confirmed: false, detail: 'no email token available for this subscription' };
      }

      try {
        await api.post('/subscription/disable', { code, token });
        log.info('Paystack subscription disabled', { code, reason: request.reason });
        return {
          confirmed: true,
          // Said plainly because it is not what "immediate" implies elsewhere:
          // Paystack stops future charges and does not claw back the period
          // already paid for. Our own row is what ends access now.
          detail: request.immediate
            ? 'future charges stopped; paid period not refunded by the provider'
            : 'future charges stopped',
        };
      } catch (err) {
        const paystackErr = err as PaystackError;

        // Disabling twice is a failure at Paystack and a success to us. This
        // has to be idempotent: erasure and reconciliation both reach for it.
        if (paystackErr.answered && /already|not active|inactive/i.test(paystackErr.message)) {
          return { confirmed: true, detail: paystackErr.message };
        }

        log.error('Paystack refused a cancellation', { code, error: paystackErr.message });
        return { confirmed: false, detail: paystackErr.message };
      }
    },

    async fetchSubscription(
      providerSubscriptionId: string,
    ): Promise<ProviderSubscriptionSnapshot | null> {
      let subscription: PaystackSubscription;
      try {
        subscription = await api.get<PaystackSubscription>(
          `/subscription/${providerSubscriptionId}`,
        );
      } catch (err) {
        const paystackErr = err as PaystackError;
        if (paystackErr.answered && /not found|cannot be found/i.test(paystackErr.message)) {
          return null;
        }
        throw err;
      }

      const status = STATUSES[subscription.status];
      if (!status) {
        // A status we have never seen is not a licence to guess — guessing
        // wrong here either bills someone who left or cuts off someone paying.
        log.error('Unknown Paystack subscription status', {
          providerSubscriptionId,
          status: subscription.status,
        });
        throw new Error(`Unknown Paystack subscription status: ${subscription.status}`);
      }

      const created = subscription.createdAt ?? subscription.created_at ?? null;

      return {
        providerSubscriptionId: subscription.subscription_code,
        providerCustomerRef: subscription.customer?.customer_code ?? null,
        status,
        // Paystack publishes when the next charge falls due and never when the
        // current period began, so this is only knowable for a subscription
        // still inside its first period. Reconciliation compares period *end*,
        // which is the field that exists.
        currentPeriodStart: created ? new Date(created) : null,
        currentPeriodEnd: subscription.next_payment_date
          ? new Date(subscription.next_payment_date)
          : null,
        cancelAtPeriodEnd: subscription.status === 'non-renewing',
      };
    },

    verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string>): boolean {
      const presented = headers['x-paystack-signature'];
      if (!presented) return false;

      // Over the bytes as received. Re-serialising the body would change them
      // — key order, whitespace, unicode escapes — and the digest with them.
      const expected = crypto
        .createHmac('sha512', secretKey)
        .update(rawBody)
        .digest('hex');

      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(presented, 'utf8');
      // Length is checked first because timingSafeEqual throws on a mismatch,
      // and a thrown comparison is not a rejected one.
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
};
