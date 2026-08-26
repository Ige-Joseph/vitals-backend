/**
 * Paystack payloads, shaped as Paystack actually sends them.
 *
 * Copied from Paystack's documented webhook bodies rather than written to suit
 * the parser — including the parts that are awkward. A fixture trimmed to what
 * the code already handles proves nothing, and the awkward parts are the
 * point:
 *
 *   - no event id anywhere, on any of them
 *   - no top-level timestamp, and `created_at` meaning different things on
 *     different events
 *   - `metadata` coming back as the integer 0 when it was left empty
 *   - `plan` present but empty on a charge that is not for a plan
 *   - `email_token` on some subscription events and not others
 */

export const PLAN_CODE = 'PLN_gx2wn530m0i3w3m';
export const SUB_CODE = 'SUB_vsyqdmlzble3uii';
export const CUSTOMER_CODE = 'CUS_xnxdt6s1zg1f4nx';
export const EMAIL_TOKEN = 'ctt824k16n34u69';

const customer = {
  id: 89321,
  first_name: 'Amara',
  last_name: 'Okafor',
  email: 'amara@example.test',
  customer_code: CUSTOMER_CODE,
  phone: null,
  metadata: null,
  risk_action: 'default',
};

const authorization = {
  authorization_code: 'AUTH_96xphygz',
  bin: '539983',
  last4: '7357',
  exp_month: '10',
  exp_year: '2027',
  channel: 'card',
  card_type: 'mastercard DEBIT',
  bank: 'Guaranty Trust Bank',
  country_code: 'NG',
  brand: 'mastercard',
  reusable: true,
  signature: 'SIG_2Gvc6pNuzJmj4TCchXfp',
};

const plan = {
  id: 28,
  name: 'Vitals Premium — Monthly',
  plan_code: PLAN_CODE,
  description: 'vitals-price:premium-monthly-2026-08',
  amount: 100_000,
  interval: 'monthly',
  send_invoices: true,
  send_sms: false,
  currency: 'NGN',
};

/**
 * The first charge. This is the one that carries our metadata, and the only
 * event in the whole flow that does — everything after it is Paystack talking
 * about objects Paystack created.
 */
export const chargeSuccess = (overrides: {
  subscriptionId?: string;
  reference?: string;
  transactionId?: number;
  amount?: number;
  paidAt?: string;
} = {}) => ({
  event: 'charge.success',
  data: {
    id: overrides.transactionId ?? 302961,
    domain: 'test',
    status: 'success',
    reference: overrides.reference ?? 'vitals-abc-1',
    amount: overrides.amount ?? 100_000,
    message: null,
    gateway_response: 'Successful',
    paid_at: overrides.paidAt ?? '2026-08-25T10:15:00.000Z',
    created_at: overrides.paidAt ?? '2026-08-25T10:14:52.000Z',
    channel: 'card',
    currency: 'NGN',
    ip_address: '102.89.34.7',
    metadata: overrides.subscriptionId
      ? {
          subscriptionId: overrides.subscriptionId,
          userId: 'ignored-by-us',
          priceId: 'premium-monthly-2026-08',
          custom_fields: [
            {
              display_name: 'Vitals subscription',
              variable_name: 'vitals_subscription_id',
              value: overrides.subscriptionId,
            },
          ],
        }
      : // Paystack returns the integer zero, not null and not {}, when no
        // metadata was sent. A property access on it throws.
        0,
    fees: 1_500,
    customer,
    authorization,
    plan,
  },
});

/** A charge that is not for a plan: `plan` comes back as an empty object. */
export const chargeSuccessNoPlan = () => ({
  event: 'charge.success',
  data: {
    ...chargeSuccess().data,
    id: 302_962,
    reference: 'one-off-ref',
    plan: {},
    metadata: 0,
  },
});

/**
 * Paystack announcing a subscription it created itself, off the back of the
 * charge above. Note there is nothing in here connecting it to that charge.
 */
export const subscriptionCreate = (overrides: { code?: string; customerCode?: string } = {}) => ({
  event: 'subscription.create',
  data: {
    domain: 'test',
    status: 'active',
    subscription_code: overrides.code ?? SUB_CODE,
    email_token: EMAIL_TOKEN,
    amount: 100_000,
    cron_expression: '0 0 25 * *',
    next_payment_date: '2026-09-25T10:15:00.000Z',
    open_invoice: null,
    createdAt: '2026-08-25T10:15:03.000Z',
    created_at: '2026-08-25T10:15:03.000Z',
    plan,
    authorization,
    customer: { ...customer, customer_code: overrides.customerCode ?? CUSTOMER_CODE },
  },
});

/**
 * A renewal. The one payload that states a billing period outright.
 */
export const invoiceUpdate = (overrides: { paid?: boolean; invoiceCode?: string } = {}) => {
  const paid = overrides.paid ?? true;
  return {
    event: 'invoice.update',
    data: {
      domain: 'test',
      invoice_code: overrides.invoiceCode ?? 'INV_kmhuaaxzt6u3jnf',
      amount: 100_000,
      period_start: '2026-09-25T10:15:00.000Z',
      period_end: '2026-10-25T10:15:00.000Z',
      status: paid ? 'success' : 'failed',
      paid,
      paid_at: paid ? '2026-09-25T10:15:04.000Z' : null,
      updated_at: '2026-09-25T10:15:06.000Z',
      description: null,
      authorization,
      subscription: {
        status: paid ? 'active' : 'attention',
        subscription_code: SUB_CODE,
        email_token: EMAIL_TOKEN,
        amount: 100_000,
        cron_expression: '0 0 25 * *',
        next_payment_date: '2026-10-25T10:15:00.000Z',
        open_invoice: paid ? null : 'INV_kmhuaaxzt6u3jnf',
      },
      customer,
      transaction: { reference: 'renewal-ref-1', status: paid ? 'success' : 'failed' },
      created_at: '2026-09-22T10:15:00.000Z',
    },
  };
};

/**
 * The disable event, with its trap intact.
 *
 * `created_at` here is the date the *subscription* was created — months before
 * the disable it is announcing. Anything that reads it as an event time will
 * conclude this cancellation happened before the activation it followed.
 */
export const subscriptionDisable = (overrides: { status?: string; code?: string } = {}) => ({
  event: 'subscription.disable',
  data: {
    domain: 'test',
    status: overrides.status ?? 'cancelled',
    subscription_code: overrides.code ?? SUB_CODE,
    email_token: EMAIL_TOKEN,
    amount: 100_000,
    cron_expression: '0 0 25 * *',
    next_payment_date: '2026-09-25T10:15:00.000Z',
    open_invoice: null,
    plan,
    authorization,
    customer,
    created_at: '2026-08-25T10:15:03.000Z',
  },
});

/** Renewal switched off. Still paid up, still entitled, just not renewing. */
export const subscriptionNotRenew = () => ({
  event: 'subscription.not_renew',
  data: {
    domain: 'test',
    status: 'non-renewing',
    subscription_code: SUB_CODE,
    email_token: EMAIL_TOKEN,
    amount: 100_000,
    next_payment_date: '2026-09-25T10:15:00.000Z',
    plan,
    customer,
    created_at: '2026-08-25T10:15:03.000Z',
  },
});

export const refundProcessed = (overrides: { transactionReference?: string } = {}) => ({
  event: 'refund.processed',
  data: {
    status: 'processed',
    transaction_reference: overrides.transactionReference ?? 'vitals-abc-1',
    refund_reference: '2085335-1699-5822',
    amount: 100_000,
    currency: 'NGN',
    channel: 'migs',
    customer,
    integration: 412_829,
    created_at: '2026-08-27T09:00:00.000Z',
    updated_at: '2026-08-27T09:02:11.000Z',
  },
});

/** Things Paystack sends that we do not act on. */
export const disputeCreate = () => ({
  event: 'charge.dispute.create',
  data: { id: 55, status: 'awaiting-merchant-feedback', customer },
});

export const invoiceCreate = () => ({
  event: 'invoice.create',
  data: { invoice_code: 'INV_upcoming', amount: 100_000, customer },
});
