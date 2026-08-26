import crypto from 'crypto';
import request from 'supertest';

import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { billingService } from '@/modules/billing/billing.service';
import { checkoutService } from '@/modules/billing/checkout.service';
import { entitlementService } from '@/modules/billing/entitlement.service';
import { eventApplier } from '@/modules/billing/event.applier';
import { reconciliationService } from '@/modules/billing/reconciliation.service';
import { providerRegistry } from '@/modules/billing/provider/provider.registry';
import { createPaystackAdapter } from '@/modules/billing/provider/paystack';
import { createUser } from './helpers/factories';
import { startPaystackStub, type PaystackStub } from './helpers/paystack-stub';
import * as fx from './helpers/paystack-fixtures';

/**
 * The Paystack adapter, rehearsed.
 *
 * Two kinds of test here, and they are testing different risks:
 *
 *   *Translation* runs Paystack's own documented payloads through `parseEvent`
 *   with no database and no network. The risk is misreading a vendor, so the
 *   fixtures are the vendor's shapes including the parts that are awkward.
 *
 *   *The flow* runs checkout to entitlement against a stub of Paystack's API
 *   on localhost, over real HTTP with the real client. The risk is the
 *   sequence — a subscription this provider names only after the money moves —
 *   so nothing here is short-circuited.
 *
 * A test secret key throughout. Nothing in this file can reach Paystack: the
 * base URL points at a socket on 127.0.0.1 for the duration.
 */

const TEST_KEY = 'sk_test_rehearsal_only_not_a_real_key';
const MONTHLY = 'premium-monthly-2026-08';

const app = createApp();

/**
 * For translation and signatures only — both are pure, neither makes a call.
 *
 * Anything that talks HTTP is built inside `beforeEach`, after the stub is
 * listening. An adapter constructed at module load captures the base URL as it
 * was then, which is exactly how a test ends up calling the real Paystack.
 */
const adapter = createPaystackAdapter(TEST_KEY);

const raw = (body: unknown) => Buffer.from(JSON.stringify(body), 'utf8');

const sign = (body: string) =>
  crypto.createHmac('sha512', TEST_KEY).update(Buffer.from(body, 'utf8')).digest('hex');

/** Sent as a string: supertest re-serialises a Buffer, which breaks the signature. */
const postWebhook = (body: unknown) => {
  const serialised = JSON.stringify(body);
  return request(app)
    .post('/api/v1/billing/webhooks/paystack')
    .set('x-paystack-signature', sign(serialised))
    .set('content-type', 'application/json')
    .send(serialised);
};

describe('translating Paystack into our vocabulary', () => {
  it('reads a first charge, including the metadata that is our only link to it', () => {
    const event = adapter.parseEvent(raw(fx.chargeSuccess({ subscriptionId: 'sub-local-1' })))!;

    expect(event.type).toBe('charge.succeeded');
    // Derived, because Paystack sends no event id at all. Keyed on the
    // transaction's own primary key, which never moves.
    expect(event.providerEventId).toBe('charge.success:302961');
    expect(event.occurredAt.toISOString()).toBe('2026-08-25T10:15:00.000Z');
    expect(event.payload).toMatchObject({
      providerReference: 'vitals-abc-1',
      providerCustomerRef: fx.CUSTOMER_CODE,
      providerPriceId: fx.PLAN_CODE,
      localSubscriptionId: 'sub-local-1',
      amountMinor: 100_000,
      currency: 'NGN',
    });
    // The charge that starts a subscription does not know the subscription.
    expect(event.payload.providerSubscriptionId).toBeUndefined();
  });

  it('survives the empty-metadata quirk instead of throwing on it', () => {
    // Paystack sends the integer 0, not null and not {}. A property access on
    // it is a TypeError, and a TypeError here is a 400 to a provider that will
    // then retry it forever.
    const event = adapter.parseEvent(raw(fx.chargeSuccessNoPlan()))!;

    expect(event.type).toBe('charge.succeeded');
    expect(event.payload.localSubscriptionId).toBeUndefined();
    expect(event.payload.providerPriceId).toBeUndefined();
  });

  it('reads the subscription Paystack created for itself', () => {
    const event = adapter.parseEvent(raw(fx.subscriptionCreate()))!;

    expect(event.type).toBe('subscription.activated');
    expect(event.payload).toMatchObject({
      providerSubscriptionId: fx.SUB_CODE,
      providerCustomerRef: fx.CUSTOMER_CODE,
      providerPriceId: fx.PLAN_CODE,
      currentPeriodEnd: '2026-09-25T10:15:00.000Z',
    });
    // Captured wherever it appears: the event that grants this token is not
    // the event that will need it.
    expect(event.payload.providerMetadata).toEqual({ emailToken: fx.EMAIL_TOKEN });
  });

  it('reads a renewal, and a failed one, from the same event name', () => {
    const renewed = adapter.parseEvent(raw(fx.invoiceUpdate({ paid: true })))!;
    const failed = adapter.parseEvent(raw(fx.invoiceUpdate({ paid: false })))!;

    expect(renewed.type).toBe('subscription.renewed');
    expect(failed.type).toBe('subscription.payment_failed');

    // The one payload that states a period outright.
    expect(renewed.payload).toMatchObject({
      currentPeriodStart: '2026-09-25T10:15:00.000Z',
      currentPeriodEnd: '2026-10-25T10:15:00.000Z',
    });

    // Same invoice, different outcome — and therefore a different event, or
    // the retry that finally succeeds would be dropped as a replay.
    expect(renewed.providerEventId).not.toBe(failed.providerEventId);
  });

  it('does not read a disable event as older than the activation it followed', () => {
    const before = Date.now();
    const event = adapter.parseEvent(raw(fx.subscriptionDisable()))!;

    expect(event.type).toBe('subscription.cancelled');

    // The payload's `created_at` is 2026-08-25 — the date the *subscription*
    // was created, not the date it was disabled. Trusting it would put this
    // event behind the activation it is cancelling, the out-of-order guard
    // would discard it, and a cancelled subscriber would keep their access.
    expect(event.occurredAt.toISOString()).not.toBe('2026-08-25T10:15:03.000Z');
    expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('tells a subscription that was cancelled from one that ran out', () => {
    expect(adapter.parseEvent(raw(fx.subscriptionDisable({ status: 'cancelled' })))!.type).toBe(
      'subscription.cancelled',
    );
    expect(adapter.parseEvent(raw(fx.subscriptionDisable({ status: 'complete' })))!.type).toBe(
      'subscription.expired',
    );
  });

  it('treats renewal being switched off as a schedule change, not a cancellation', () => {
    const event = adapter.parseEvent(raw(fx.subscriptionNotRenew()))!;

    expect(event.type).toBe('subscription.cancel_scheduled');
    expect(event.payload.cancelAtPeriodEnd).toBe(true);
  });

  it('files a refund under its own reference, not the charge it reverses', () => {
    const charge = adapter.parseEvent(raw(fx.chargeSuccess()))!;
    const refund = adapter.parseEvent(raw(fx.refundProcessed()))!;

    expect(refund.type).toBe('charge.refunded');
    // Sharing a reference would make the refund collide with the charge on the
    // unique index and vanish.
    expect(refund.payload.providerReference).not.toBe(charge.payload.providerReference);
  });

  it('drops what we do not act on rather than failing on it', () => {
    // Acknowledged and not stored. Failing would make Paystack retry
    // something we are never going to understand.
    expect(adapter.parseEvent(raw(fx.disputeCreate()))).toBeNull();
    expect(adapter.parseEvent(raw(fx.invoiceCreate()))).toBeNull();
    expect(adapter.parseEvent(raw({ event: 'something.invented.later', data: {} }))).toBeNull();
  });

  it('refuses a body that is not a Paystack webhook', () => {
    expect(() => adapter.parseEvent(Buffer.from('not json'))).toThrow(/not valid JSON/);
    expect(() => adapter.parseEvent(raw({ hello: 'world' }))).toThrow(/envelope/);
  });

  it('gives the same event the same id however often it is redelivered', () => {
    const first = adapter.parseEvent(raw(fx.subscriptionCreate()))!;
    const again = adapter.parseEvent(raw(fx.subscriptionCreate()))!;
    expect(first.providerEventId).toBe(again.providerEventId);

    // And different subscriptions different ids, or the second would be
    // silently swallowed as a duplicate of the first.
    const other = adapter.parseEvent(raw(fx.subscriptionCreate({ code: 'SUB_other' })))!;
    expect(other.providerEventId).not.toBe(first.providerEventId);
  });
});

describe('signature verification', () => {
  it('accepts the bytes Paystack signed and nothing else', () => {
    const body = JSON.stringify(fx.chargeSuccess());
    const bytes = Buffer.from(body, 'utf8');

    expect(
      adapter.verifyWebhookSignature(bytes, { 'x-paystack-signature': sign(body) }),
    ).toBe(true);

    // Re-serialised: same object, different bytes, different digest. This is
    // exactly what a JSON body parser in front of the route would do.
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body)) + ' ', 'utf8');
    expect(
      adapter.verifyWebhookSignature(reserialised, { 'x-paystack-signature': sign(body) }),
    ).toBe(false);

    expect(adapter.verifyWebhookSignature(bytes, {})).toBe(false);
    expect(
      adapter.verifyWebhookSignature(bytes, { 'x-paystack-signature': 'short' }),
    ).toBe(false);
  });
});

describe('checkout through to entitlement', () => {
  let stub: PaystackStub;
  let originalBaseUrl: string;
  /** Built against the stub. The only adapter in this suite that makes calls. */
  let live: ReturnType<typeof createPaystackAdapter>;

  beforeEach(async () => {
    stub = await startPaystackStub();
    originalBaseUrl = env.PAYSTACK_BASE_URL;
    // Read when an adapter is constructed, so this has to be set first.
    (env as any).PAYSTACK_BASE_URL = stub.baseUrl;

    live = createPaystackAdapter(TEST_KEY);
    providerRegistry.register(live);
    await billingService.syncPrices();
  });

  afterEach(async () => {
    (env as any).PAYSTACK_BASE_URL = originalBaseUrl;
    await stub.close();
  });

  it('goes from a chosen price to an active subscription and Premium', async () => {
    const user = await createUser();

    const session = await checkoutService.start({ userId: user.id, priceId: MONTHLY });

    expect(session.redirectUrl).toContain('checkout.paystack.test');

    // The plan was created once and remembered, so a second purchase does not
    // create a second plan for the same price.
    const price = await prisma.price.findUniqueOrThrow({ where: { id: MONTHLY } });
    expect(price.providerPriceId).toBe(fx.PLAN_CODE);
    expect(price.provider).toBe('PAYSTACK');

    // The transaction was initialised against that plan, which is what makes
    // it recurring rather than a one-off payment we would have to renew.
    const initialise = stub.calls.find((c) => c.path === '/transaction/initialize')!;
    expect(initialise.body.plan).toBe(fx.PLAN_CODE);
    expect(initialise.body.amount).toBe(100_000);
    expect(initialise.body.metadata.subscriptionId).toBe(session.subscriptionId);

    // Local row exists before the payer has even seen the page, and grants
    // nothing yet.
    const pending = await prisma.subscription.findUniqueOrThrow({
      where: { id: session.subscriptionId },
    });
    expect(pending.status).toBe('INCOMPLETE');
    expect(pending.priceId).toBe(MONTHLY);
    expect(pending.providerCustomerRef).toBe(fx.CUSTOMER_CODE);
    expect((await entitlementService.resolve(user.id)).tier).toBe('FREE');

    // ── The payer pays. Paystack tells us about the money first. ──
    const charge = await postWebhook(
      fx.chargeSuccess({
        subscriptionId: session.subscriptionId,
        reference: initialise.body.reference,
      }),
    );
    expect(charge.status).toBe(200);
    expect(charge.body.data.status).toBe('accepted');

    const chargeEvent = await prisma.billingWebhookEvent.findFirstOrThrow({
      where: { type: 'charge.succeeded' },
    });
    expect(await eventApplier.apply(chargeEvent.id)).toBe('applied');

    // A charge that cleared is enough on its own. Waiting for the
    // subscription announcement would leave someone who has paid with nothing
    // if that delivery were dropped.
    const afterCharge = await prisma.subscription.findUniqueOrThrow({
      where: { id: session.subscriptionId },
    });
    expect(afterCharge.status).toBe('ACTIVE');
    expect(afterCharge.currentPeriodEnd).not.toBeNull();
    expect((await entitlementService.resolve(user.id)).tier).toBe('PREMIUM');

    const booked = await prisma.paymentTransaction.findUniqueOrThrow({
      where: { providerReference: initialise.body.reference },
    });
    expect(booked.type).toBe('CHARGE');
    expect(booked.amountMinor).toBe(100_000);
    expect(booked.subscriptionId).toBe(session.subscriptionId);

    // ── Then Paystack announces the subscription it made for itself. ──
    const created = await postWebhook(fx.subscriptionCreate());
    expect(created.status).toBe(200);

    const createEvent = await prisma.billingWebhookEvent.findFirstOrThrow({
      where: { type: 'subscription.activated' },
    });
    expect(await eventApplier.apply(createEvent.id)).toBe('applied');

    const claimed = await prisma.subscription.findUniqueOrThrow({
      where: { id: session.subscriptionId },
    });
    // Without this the subscription could never be cancelled or reconciled —
    // and the charge had already stamped a newer timestamp on the row, so the
    // claim had to survive the staleness guard to get here.
    expect(claimed.providerSubscriptionId).toBe(fx.SUB_CODE);
    expect(claimed.providerMetadata).toMatchObject({ emailToken: fx.EMAIL_TOKEN });
    expect(claimed.status).toBe('ACTIVE');
  });

  it('keeps a subscriber on the price they bought when the price changes', async () => {
    const user = await createUser();
    const session = await checkoutService.start({ userId: user.id, priceId: MONTHLY });

    const initialise = stub.calls.find((c) => c.path === '/transaction/initialize')!;
    await postWebhook(
      fx.chargeSuccess({
        subscriptionId: session.subscriptionId,
        reference: initialise.body.reference,
      }),
    );
    const event = await prisma.billingWebhookEvent.findFirstOrThrow({
      where: { type: 'charge.succeeded' },
    });
    await eventApplier.apply(event.id);

    // Now Premium is repriced: the old price is retired, a new one is added.
    await prisma.price.update({ where: { id: MONTHLY }, data: { active: false } });
    await prisma.price.create({
      data: {
        id: 'premium-monthly-2027-01',
        tier: 'PREMIUM',
        label: 'Monthly',
        amountMinor: 150_000,
        currency: 'NGN',
        interval: 'month',
        intervalCount: 1,
        active: true,
      },
    });

    const held = await prisma.subscription.findUniqueOrThrow({
      where: { id: session.subscriptionId },
      include: { price: true },
    });

    // Still pointing at the record it was bought at, still ₦1,000, still
    // Premium. Nothing had to remember to protect them — the subscription
    // stores a price id and prices are never edited in place.
    expect(held.priceId).toBe(MONTHLY);
    expect(held.price.amountMinor).toBe(100_000);
    expect(held.price.active).toBe(false);
    expect((await entitlementService.resolve(user.id)).tier).toBe('PREMIUM');

    // And nobody new can buy the retired one.
    await expect(
      checkoutService.start({ userId: (await createUser()).id, priceId: MONTHLY }),
    ).rejects.toThrow(/no longer offered/);
  });

  it('reuses an abandoned attempt rather than leaving rows the provider can confuse', async () => {
    const user = await createUser();

    const first = await checkoutService.start({ userId: user.id, priceId: MONTHLY });
    const second = await checkoutService.start({ userId: user.id, priceId: MONTHLY });

    expect(second.subscriptionId).toBe(first.subscriptionId);
    expect(await prisma.subscription.count({ where: { userId: user.id } })).toBe(1);

    // A fresh reference each time, because a provider will not accept the same
    // one twice — but one row, so "the row for this customer and this price"
    // still identifies exactly one thing.
    const references = stub.calls
      .filter((c) => c.path === '/transaction/initialize')
      .map((c) => c.body.reference);
    expect(new Set(references).size).toBe(2);
  });

  it('cancels with the token Paystack demands alongside the code', async () => {
    const user = await createUser();
    const session = await checkoutService.start({ userId: user.id, priceId: MONTHLY });

    // Get the subscription to the state a real one reaches: named, with the
    // token captured off the event that carried it.
    await postWebhook(fx.subscriptionCreate());
    const created = await prisma.billingWebhookEvent.findFirstOrThrow({
      where: { type: 'subscription.activated' },
    });
    await eventApplier.apply(created.id);

    const result = await checkoutService.cancel({
      userId: user.id,
      subscriptionId: session.subscriptionId,
    });

    expect(result.confirmedByProvider).toBe(true);

    const disable = stub.calls.find((c) => c.path === '/subscription/disable')!;
    expect(disable.body).toEqual({ code: fx.SUB_CODE, token: fx.EMAIL_TOKEN });

    // Never fetched — the token was already held, which is the whole reason
    // it is captured from every event that carries one.
    expect(stub.calls.some((c) => c.path.startsWith('/subscription/SUB'))).toBe(false);

    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: session.subscriptionId },
    });
    expect(after.status).toBe('CANCELED');
    expect(after.cancelAtPeriodEnd).toBe(true);
    // They paid for this period and they keep it.
    expect(after.endedAt).toBeNull();
    expect((await entitlementService.resolve(user.id)).tier).toBe('PREMIUM');
  });

  it('fetches the token when no event ever carried one', async () => {
    const user = await createUser();
    const session = await checkoutService.start({ userId: user.id, priceId: MONTHLY });

    await prisma.subscription.update({
      where: { id: session.subscriptionId },
      data: { status: 'ACTIVE', providerSubscriptionId: fx.SUB_CODE, providerMetadata: {} },
    });

    stub.route('GET /subscription/:id', () => [
      200,
      {
        status: true,
        message: 'ok',
        data: {
          subscription_code: fx.SUB_CODE,
          email_token: 'fetched_token',
          status: 'active',
          next_payment_date: '2026-09-25T10:15:00.000Z',
        },
      },
    ]);

    await checkoutService.cancel({ userId: user.id, subscriptionId: session.subscriptionId });

    const disable = stub.calls.find((c) => c.path === '/subscription/disable')!;
    expect(disable.body.token).toBe('fetched_token');
  });

  it('treats a subscription the provider has already disabled as cancelled', async () => {
    // Idempotence is not optional: erasure and reconciliation both call this,
    // and a second call must not leave a cancellation looking unconfirmed
    // forever.
    stub.route('POST /subscription/disable', () => [
      400,
      { status: false, message: 'This subscription has already been disabled', data: null },
    ]);

    const result = await live.cancelSubscription({
      providerSubscriptionId: fx.SUB_CODE,
      providerMetadata: { emailToken: fx.EMAIL_TOKEN },
      immediate: true,
      reason: 'test',
    });

    expect(result.confirmed).toBe(true);
  });

  it('does not report a cancellation as confirmed when the provider never answered', async () => {
    stub.route('POST /subscription/disable', () => [500, { status: false, message: 'boom' }]);

    const result = await live.cancelSubscription({
      providerSubscriptionId: fx.SUB_CODE,
      providerMetadata: { emailToken: fx.EMAIL_TOKEN },
      immediate: true,
      reason: 'test',
    });

    // Unconfirmed, so reconciliation keeps retrying it. Reporting success here
    // is how an erased account stays billed.
    expect(result.confirmed).toBe(false);
  });

  it('refuses a period Paystack cannot express rather than selling the wrong one', async () => {
    await expect(
      live.ensurePlan({
        id: 'premium-two-monthly',
        label: 'Every two months',
        amountMinor: 200_000,
        currency: 'NGN',
        interval: 'month',
        intervalCount: 2,
      }),
    ).rejects.toThrow(/cannot bill every 2 month/);
  });

  it('reconciles our state back to the provider when they disagree', async () => {
    const user = await createUser();
    const session = await checkoutService.start({ userId: user.id, priceId: MONTHLY });
    await prisma.subscription.update({
      where: { id: session.subscriptionId },
      data: {
        status: 'ACTIVE',
        providerSubscriptionId: fx.SUB_CODE,
        currentPeriodEnd: new Date('2026-09-25T10:15:00.000Z'),
      },
    });

    // Paystack says renewal is off. We never got the event.
    stub.route('GET /subscription/:id', () => [
      200,
      {
        status: true,
        message: 'ok',
        data: {
          subscription_code: fx.SUB_CODE,
          email_token: fx.EMAIL_TOKEN,
          status: 'non-renewing',
          next_payment_date: '2026-09-25T10:15:00.000Z',
          customer: { customer_code: fx.CUSTOMER_CODE },
        },
      },
    ]);

    const result = await reconciliationService.reconcileSubscriptions();
    expect(result.corrected).toBe(1);

    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: session.subscriptionId },
    });
    // Still ACTIVE, because "non-renewing" is a schedule, not an ending: they
    // paid for this period. Only the renewal flag moved.
    expect(after.status).toBe('ACTIVE');
    expect(after.cancelAtPeriodEnd).toBe(true);
  });
});

describe('events that give up', () => {
  it('dead-letters an exhausted event, shouts about it, and never retries it', async () => {
    const event = await prisma.billingWebhookEvent.create({
      data: {
        provider: 'PAYSTACK',
        providerEventId: 'charge.success:doomed',
        type: 'charge.succeeded',
        occurredAt: new Date(),
        status: 'FAILED',
        // The queue has already spent the budget on this one.
        retryCount: env.BILLING_EVENT_MAX_ATTEMPTS,
        error: 'database was down',
        payload: { providerReference: 'doomed-ref' },
        receivedAt: new Date(Date.now() - 3_600_000),
      },
    });

    const swept = await reconciliationService.sweepStalledEvents();

    expect(swept.deadLettered).toBe(1);
    expect(swept.deadLetterBacklog).toBe(1);

    const after = await prisma.billingWebhookEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(after.status).toBe('DEAD_LETTERED');

    // And nothing picks it back up on its own. Silently reprocessing it is
    // how a billing failure becomes a billing failure nobody knows about.
    expect(await eventApplier.apply(event.id)).toBe('ignored');
    expect(await prisma.paymentTransaction.count()).toBe(0);

    const again = await reconciliationService.sweepStalledEvents();
    expect(again.redriven).toBe(0);
    // Still reported, every pass — a backlog that is not going down is the
    // thing worth seeing.
    expect(again.deadLetterBacklog).toBe(1);
  });

  it('re-drives an event whose queue job went missing, with the budget it has left', async () => {
    const event = await prisma.billingWebhookEvent.create({
      data: {
        provider: 'PAYSTACK',
        providerEventId: 'charge.success:stalled',
        type: 'charge.succeeded',
        occurredAt: new Date(),
        status: 'PENDING',
        retryCount: 2,
        payload: { providerReference: 'stalled-ref' },
        // Long past the point where processing should have happened.
        receivedAt: new Date(Date.now() - 3_600_000),
      },
    });

    const swept = await reconciliationService.sweepStalledEvents();

    expect(swept.redriven).toBe(1);
    expect(swept.deadLettered).toBe(0);

    const after = await prisma.billingWebhookEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    // Left alone. Re-driving is enqueueing, not applying.
    expect(after.status).toBe('PENDING');
  });

  it('leaves an event that has only just arrived alone', async () => {
    await prisma.billingWebhookEvent.create({
      data: {
        provider: 'PAYSTACK',
        providerEventId: 'charge.success:fresh',
        type: 'charge.succeeded',
        occurredAt: new Date(),
        status: 'PENDING',
        payload: {},
      },
    });

    const swept = await reconciliationService.sweepStalledEvents();
    // A slow retry backoff is not a lost job.
    expect(swept.redriven).toBe(0);
    expect(swept.deadLettered).toBe(0);
  });
});
