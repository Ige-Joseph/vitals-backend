import request from 'supertest';
import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import { billingService } from '@/modules/billing/billing.service';
import { entitlementService } from '@/modules/billing/entitlement.service';
import { eventApplier } from '@/modules/billing/event.applier';
import { webhookService } from '@/modules/billing/webhook.service';
import { reconciliationService } from '@/modules/billing/reconciliation.service';
import { providerRegistry } from '@/modules/billing/provider/provider.registry';
import { erasureService } from '@/modules/person/erasure.service';
import { createUser } from './helpers/factories';

/**
 * Webhook intake, event application and reconciliation.
 *
 * A stub adapter stands in for a provider so the guarantees can be exercised;
 * no real integration exists.
 */

const app = createApp();

const MONTHLY = 'premium-monthly-2026-08';
const at = (offsetMs: number) => new Date(Date.now() + offsetMs);

/**
 * Minimal adapter: signature is valid iff the header says so, and events are
 * already in our vocabulary.
 *
 * Deliberately not the Paystack adapter. These tests are about the guarantees
 * intake makes — replay, ordering, grace, refund-after-erasure — and running
 * them through a real vendor's translation would test both at once and locate
 * a failure in neither. The Paystack translation has its own suite.
 */
const stubAdapter = {
  name: 'PAYSTACK' as const,
  parseEvent: (rawBody: Buffer) => {
    const parsed = JSON.parse(rawBody.toString('utf8'));
    if (!parsed.providerEventId) return null;
    return {
      providerEventId: parsed.providerEventId,
      type: parsed.type,
      occurredAt: new Date(parsed.occurredAt),
      payload: parsed.payload ?? {},
    };
  },
  ensurePlan: async (price: { id: string }) => `plan_${price.id}`,
  createCheckout: async () => ({
    redirectUrl: 'https://example.test',
    providerReference: 'ref',
    providerCustomerRef: null,
    providerMetadata: {},
  }),
  cancelSubscription: async () => ({ confirmed: true }),
  fetchSubscription: async () => null,
  verifyWebhookSignature: (_raw: Buffer, headers: Record<string, string>) =>
    headers['x-signature'] === 'valid',
};

async function subscribe(userId: string, providerSubscriptionId: string) {
  await billingService.syncPrices();
  return prisma.subscription.create({
    data: {
      userId,
      priceId: MONTHLY,
      status: 'ACTIVE',
      provider: 'PAYSTACK',
      providerSubscriptionId,
      providerCustomerRef: `cus_${userId}`,
      currentPeriodStart: at(-86_400_000),
      currentPeriodEnd: at(30 * 86_400_000),
    },
  });
}

// Sent as a string, not a Buffer: supertest re-serialises a Buffer when the
// content type is JSON, which would defeat the point of signing raw bytes.
const post = (body: unknown, signature = 'valid') =>
  request(app)
    .post('/api/v1/billing/webhooks/paystack')
    .set('x-signature', signature)
    .set('content-type', 'application/json')
    .send(JSON.stringify(body));

describe('signature verification comes before anything else', () => {
  beforeEach(() => providerRegistry.register(stubAdapter));

  it('rejects an unsigned request without recording it', async () => {
    const res = await post({ providerEventId: 'evt_unsigned', type: 'x', occurredAt: new Date() }, 'nope');

    expect(res.status).toBe(401);
    // Nothing reached the database — an unauthenticated request is not a
    // malformed event, it is one that should never have been read.
    expect(await prisma.billingWebhookEvent.count()).toBe(0);
  });

  it('accepts a correctly signed one', async () => {
    const res = await post({
      providerEventId: 'evt_ok',
      type: 'charge.succeeded',
      occurredAt: new Date(),
      payload: {},
    });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('accepted');
    expect(await prisma.billingWebhookEvent.count()).toBe(1);
  });
});

describe('a replayed event is a no-op', () => {
  beforeEach(() => providerRegistry.register(stubAdapter));

  it('records once however many times it arrives', async () => {
    const body = {
      providerEventId: 'evt_replay',
      type: 'charge.succeeded',
      occurredAt: new Date(),
      payload: { providerReference: 'ch_1', amountMinor: 100_000 },
    };

    const first = await post(body);
    const second = await post(body);
    // Byte-different but the same event id — keyed on the id, not the payload.
    const third = await post({ ...body, payload: { ...body.payload, extra: true } });

    expect(first.body.data.status).toBe('accepted');
    expect(second.body.data.status).toBe('duplicate');
    expect(third.body.data.status).toBe('duplicate');

    // A duplicate is still a 200: anything else invites the provider to
    // retry forever.
    expect(second.status).toBe(200);

    expect(await prisma.billingWebhookEvent.count()).toBe(1);
  });
});

describe('a stale event does not overwrite newer state', () => {
  it('applies newer, then ignores older regardless of arrival order', async () => {
    const user = await createUser();
    const sub = await subscribe(user.id, 'sub_order');

    const cancelled = await prisma.billingWebhookEvent.create({
      data: {
        provider: 'PAYSTACK',
        providerEventId: 'evt_cancelled',
        type: 'subscription.cancelled',
        occurredAt: at(0),
        payload: { providerSubscriptionId: 'sub_order' },
      },
    });

    // Emitted *before* the cancellation, delivered after it.
    const renewed = await prisma.billingWebhookEvent.create({
      data: {
        provider: 'PAYSTACK',
        providerEventId: 'evt_renewed',
        type: 'subscription.renewed',
        occurredAt: at(-60_000),
        payload: { providerSubscriptionId: 'sub_order' },
      },
    });

    expect(await eventApplier.apply(cancelled.id)).toBe('applied');
    expect(await eventApplier.apply(renewed.id)).toBe('ignored');

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    // Arrival order said "renewed last". Event order said otherwise, and
    // event order is the one that counts.
    expect(after.status).toBe('CANCELED');

    const staleEvent = await prisma.billingWebhookEvent.findUniqueOrThrow({
      where: { id: renewed.id },
    });
    expect(staleEvent.status).toBe('IGNORED');
  });

  it('confirms a cancellation reconciliation was waiting on', async () => {
    const user = await createUser();
    const sub = await subscribe(user.id, 'sub_confirm');
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { cancellationRequestedAt: at(-3_600_000) },
    });

    const event = await prisma.billingWebhookEvent.create({
      data: {
        provider: 'PAYSTACK',
        providerEventId: 'evt_confirm',
        type: 'subscription.cancelled',
        occurredAt: at(0),
        payload: { providerSubscriptionId: 'sub_confirm' },
      },
    });

    await eventApplier.apply(event.id);

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.cancellationConfirmedAt).not.toBeNull();
  });
});

describe('the past-due grace window is bounded by the failed charge', () => {
  it('grants inside the window and stops after it, whatever the period says', async () => {
    const user = await createUser();
    const sub = await subscribe(user.id, 'sub_grace');

    const failed = await prisma.billingWebhookEvent.create({
      data: {
        provider: 'PAYSTACK',
        providerEventId: 'evt_failed',
        type: 'subscription.payment_failed',
        occurredAt: at(0),
        payload: { providerSubscriptionId: 'sub_grace' },
      },
    });
    await eventApplier.apply(failed.id);

    const during = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(during.status).toBe('PAST_DUE');
    expect(during.pastDueSince).not.toBeNull();

    // Inside the window: still Premium. A card that failed today is a payment
    // problem, not a reason to lose a dependent's records.
    expect((await entitlementService.resolve(user.id)).tier).toBe('PREMIUM');

    // Push the failure back beyond the window. The paid period still has
    // weeks to run, and that no longer matters.
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { pastDueSince: at(-8 * 86_400_000) },
    });

    expect((await entitlementService.resolve(user.id)).tier).toBe('FREE');
    const stillPaid = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(stillPaid.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now());
  });

  it('clears the window when payment recovers', async () => {
    const user = await createUser();
    const sub = await subscribe(user.id, 'sub_recover');

    for (const [id, type, offset] of [
      ['evt_fail2', 'subscription.payment_failed', -120_000],
      ['evt_ok2', 'subscription.renewed', 0],
    ] as const) {
      const e = await prisma.billingWebhookEvent.create({
        data: {
          provider: 'PAYSTACK',
          providerEventId: id,
          type,
          occurredAt: at(offset),
          payload: { providerSubscriptionId: 'sub_recover' },
        },
      });
      await eventApplier.apply(e.id);
    }

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('ACTIVE');
    expect(after.pastDueSince).toBeNull();
  });
});

describe('a refund arriving after erasure still lands', () => {
  it('records it with no personal link, matched on provider references', async () => {
    const user = await createUser();
    const sub = await subscribe(user.id, 'sub_erased');

    const charge = await prisma.billingWebhookEvent.create({
      data: {
        provider: 'PAYSTACK',
        providerEventId: 'evt_charge',
        type: 'charge.succeeded',
        occurredAt: at(-86_400_000),
        payload: {
          providerSubscriptionId: 'sub_erased',
          providerReference: 'ch_erased',
          providerCustomerRef: `cus_${user.id}`,
          amountMinor: 100_000,
        },
      },
    });
    await eventApplier.apply(charge.id);

    await erasureService.execute(user.id, user.id);

    // The refund arrives afterwards, for an account that no longer exists.
    const refund = await prisma.billingWebhookEvent.create({
      data: {
        provider: 'PAYSTACK',
        providerEventId: 'evt_refund',
        type: 'charge.refunded',
        occurredAt: at(0),
        payload: {
          providerSubscriptionId: 'sub_erased',
          providerReference: 'rf_erased',
          providerCustomerRef: `cus_${user.id}`,
          amountMinor: 100_000,
        },
      },
    });

    expect(await eventApplier.apply(refund.id)).toBe('applied');

    const landed = await prisma.paymentTransaction.findUniqueOrThrow({
      where: { providerReference: 'rf_erased' },
    });
    expect(landed.type).toBe('REFUND');
    // No user attached — there is nobody to attach — but attributable.
    expect(landed.userId).toBeNull();
    expect(landed.subscriptionId).toBe(sub.id);
    expect(landed.providerCustomerRef).toBe(`cus_${user.id}`);

    const trail = await prisma.paymentTransaction.findMany({
      where: { providerCustomerRef: `cus_${user.id}` },
      orderBy: { occurredAt: 'asc' },
    });
    expect(trail.map(t => t.type)).toEqual(['CHARGE', 'REFUND']);
  });
});

describe('reconciliation retries what erasure could not confirm', () => {
  it('confirms a pending cancellation once the provider answers', async () => {
    const user = await createUser();
    const sub = await subscribe(user.id, 'sub_retry');
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: 'PAST_DUE',
        cancellationRequestedAt: at(-3_600_000),
        cancellationConfirmedAt: null,
      },
    });

    providerRegistry.register(stubAdapter);

    const result = await reconciliationService.retryUnconfirmedCancellations();
    expect(result.attempted).toBeGreaterThanOrEqual(1);
    expect(result.confirmed).toBeGreaterThanOrEqual(1);

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.cancellationConfirmedAt).not.toBeNull();
  });
});
