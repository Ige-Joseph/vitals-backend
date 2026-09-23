import type { PaymentProvider } from '@prisma/client';

/**
 * What a payment provider has to be able to do.
 *
 * No provider is implemented. This exists so the rest of billing can be built,
 * tested and reasoned about against a shape rather than against Paystack's or
 * Flutterwave's particular vocabulary — and so that adding one is writing an
 * adapter rather than threading a vendor through the codebase.
 *
 * Everything here is expressed in *our* terms. A provider that calls a period
 * something else, or reports a status we do not have, translates in its
 * adapter; nothing outside this folder should ever see a vendor's payload
 * except as the opaque blob stored on PaymentTransaction.
 */

/** A subscription as the provider currently sees it. */
export interface ProviderSubscriptionSnapshot {
  providerSubscriptionId: string;
  providerCustomerRef: string | null;
  /** Already translated into our vocabulary by the adapter. */
  status: 'INCOMPLETE' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'EXPIRED';
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export interface CheckoutRequest {
  /** Our subscription row, created before checkout so a webhook can find it. */
  subscriptionId: string;
  priceId: string;
  /** The provider's handle for the plan, from ensurePlan. */
  providerPlanId: string;
  /**
   * Which attempt at paying for this subscription this is, from 1.
   *
   * A payer who abandons a checkout and comes back reuses the subscription
   * row, and a provider will not accept the same payment reference twice. The
   * attempt is what keeps one stable row and a fresh reference each time.
   */
  attempt: number;
  amountMinor: number;
  currency: string;
  /** Where the provider returns the payer afterwards. */
  returnUrl: string;
  /** Opaque to the provider; comes back on the webhook. */
  metadata: Record<string, string>;
  customer: {
    /**
     * Providers need something to bill against. This is the one place an
     * email leaves our system for billing, and it is passed rather than
     * stored provider-side by us.
     */
    email: string;
    reference: string | null;
  };
}

export interface CheckoutSession {
  /** Where the payer is sent. Always absolute. */
  redirectUrl: string;
  providerReference: string;
  /**
   * The provider's handle for the payer, if it named one before payment.
   *
   * Worth having early. Some providers do not tell us the subscription id
   * until the first charge clears, and the customer is then the only thing
   * connecting the eventual subscription back to the row we created here.
   */
  providerCustomerRef: string | null;
  /** Adapter-private handles to persist alongside the subscription. */
  providerMetadata: Record<string, unknown>;
}

export interface CancelRequest {
  providerSubscriptionId: string;
  /**
   * Whatever else the provider needs to act on this subscription, opaque to
   * everyone but the adapter. Paystack will not cancel on the subscription
   * code alone.
   */
  providerMetadata?: Record<string, unknown>;
  /**
   * Immediate cancellation ends access now; otherwise the subscriber keeps
   * what they paid for until the period ends.
   *
   * Erasure uses immediate — an account that no longer exists cannot be
   * charged again, and cannot be left holding entitlement either.
   */
  immediate: boolean;
  reason: string;
}

export interface CancelResult {
  /** False when the provider was unreachable — never a reason to block erasure. */
  confirmed: boolean;
  /** Present when the provider reported something we should record. */
  detail?: string;
}

/**
 * An inbound event, translated into our vocabulary.
 *
 * Every field is ours. A provider's own names, statuses and shapes stop at the
 * adapter boundary — nothing outside this folder should be able to tell which
 * provider an event came from by looking at it.
 */
/**
 * What an event tells us, in our field names.
 *
 * Every field is optional because providers differ in what they put on which
 * event, and an absent field means "this event says nothing about that" — not
 * "set it to null". The applier writes only what is present.
 */
export interface NormalisedEventPayload {
  providerSubscriptionId?: string;
  providerCustomerRef?: string;
  providerReference?: string;
  /** The provider's handle for the price, matching Price.providerPriceId. */
  providerPriceId?: string;
  /** Our own subscription id, if it survived the round trip through checkout. */
  localSubscriptionId?: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  amountMinor?: number;
  currency?: string;
  cancelAtPeriodEnd?: boolean;
  /** Adapter-private handles worth keeping. Never read outside the adapter. */
  providerMetadata?: Record<string, unknown>;
}

export interface NormalisedEvent {
  /**
   * Stable and unique per event.
   *
   * Some providers supply one. Others do not, and the adapter has to derive
   * something that is stable across redeliveries of the *same* event and
   * distinct between different ones — that derivation is the adapter's
   * problem, not intake's.
   */
  providerEventId: string;
  type: string;
  /** When the provider says it happened. Used for out-of-order protection. */
  occurredAt: Date;
  payload: Record<string, unknown>;
}

export interface PaymentProviderAdapter {
  readonly name: PaymentProvider;

  /**
   * Turn a raw provider body into an event in our terms.
   *
   * Returns null for anything we do not act on, so intake can acknowledge it
   * without storing noise. Called only after the signature has been verified.
   */
  parseEvent(rawBody: Buffer): NormalisedEvent | null;

  /**
   * Make sure a price is purchasable at the provider, returning its handle.
   *
   * Recurring billing is the provider's job — a plan there renews on its own
   * schedule and tells us about it, which is a great deal less to get wrong
   * than a renewal loop of our own.
   */
  ensurePlan(price: {
    id: string;
    label: string;
    amountMinor: number;
    currency: string;
    interval: string;
    intervalCount: number;
  }): Promise<string>;

  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;

  /**
   * Stop future charges.
   *
   * Must be safe to call more than once and safe to call for a subscription
   * the provider has already cancelled — erasure and reconciliation will both
   * reach for it, and neither can afford it to throw on a repeat.
   */
  cancelSubscription(request: CancelRequest): Promise<CancelResult>;

  /** The provider's current view, for reconciliation to compare against ours. */
  fetchSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot | null>;

  /**
   * Whether a webhook really came from the provider.
   *
   * Part of the interface even though webhook handling is a later session:
   * an adapter that cannot answer this is not safe to accept events from, and
   * building the interface without it invites someone to skip it.
   */
  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string>): boolean;
}
