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
}

export interface CancelRequest {
  providerSubscriptionId: string;
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

export interface PaymentProviderAdapter {
  readonly name: PaymentProvider;

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
