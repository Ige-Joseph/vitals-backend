import request from 'supertest';

import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { billingService } from '@/modules/billing/billing.service';
import { checkoutService } from '@/modules/billing/checkout.service';
import { providerRegistry } from '@/modules/billing/provider/provider.registry';
import { createPaystackAdapter } from '@/modules/billing/provider/paystack';
import { createUser, authHeader } from './helpers/factories';
import { startPaystackStub, type PaystackStub } from './helpers/paystack-stub';

/**
 * Two things the billing surface could not say, and now can.
 *
 * Both were invisibility rather than error. A checkout in flight left an
 * INCOMPLETE row that grants nothing, so it never appeared in `subscription`
 * and a payer who closed the tab mid-payment came back to a page that had
 * forgotten them. And the tier list — the same for everybody, secret from
 * nobody — sat behind `authenticate`, so a shared link to the billing page
 * answered a signed-out visitor with a 401.
 *
 * Everything here runs against real rows in a real database. Where a state is
 * hard to reach honestly — a checkout old enough to have gone stale — the row
 * is aged with SQL rather than mocked, so what is under test is still the
 * query that will run in production.
 */

const app = createApp();

const MONTHLY = 'premium-monthly-2026-08';
const ANNUAL = 'premium-annual-2026-08';
const TEST_KEY = 'sk_test_rehearsal_only_not_a_real_key';

/** A checkout that was started and never finished. */
const startedCheckout = (userId: string, priceId = MONTHLY) =>
  prisma.subscription.create({
    data: { userId, priceId, status: 'INCOMPLETE', provider: 'PAYSTACK' },
  });

/**
 * Push a row's `updatedAt` into the past.
 *
 * Raw SQL on purpose: `@updatedAt` means Prisma rewrites the column on every
 * update it issues, so the one way to age a row is to go around it.
 */
const age = async (subscriptionId: string, minutesAgo: number) => {
  const when = new Date(Date.now() - minutesAgo * 60_000);
  await prisma.$executeRaw`
    UPDATE subscriptions SET "updatedAt" = ${when} WHERE id = ${subscriptionId}
  `;
};

beforeEach(async () => {
  // Truncation between cases takes the price rows with it, and a subscription
  // cannot point at a price that is not there.
  await billingService.syncPrices();
});

describe('a checkout in flight is visible to the account that started it', () => {
  it('reports nothing for an account that has never started one', async () => {
    const user = await createUser();

    const plan = await billingService.getPlan(user.id);

    expect(plan.pendingCheckout).toBeNull();
    expect(plan.subscription).toBeNull();
    expect(plan.tier).toBe('FREE');
  });

  it('reports the subscription, price and start time of one that was', async () => {
    const user = await createUser();
    const subscription = await startedCheckout(user.id, ANNUAL);

    const plan = await billingService.getPlan(user.id);

    expect(plan.pendingCheckout).toEqual({
      subscriptionId: subscription.id,
      priceId: ANNUAL,
      startedAt: expect.any(Date),
    });
    // Still granting nothing. A started checkout is not a subscription.
    expect(plan.tier).toBe('FREE');
    expect(plan.subscription).toBeNull();
  });

  it('stops reporting one that has gone stale', async () => {
    const user = await createUser();
    const subscription = await startedCheckout(user.id);

    // Inside the window: still worth mentioning.
    await age(subscription.id, 90);
    expect(await checkoutService.pending(user.id)).not.toBeNull();

    // Past it: the row survives, because matching a provider-created
    // subscription back to us still needs it — it just stops being news.
    await age(subscription.id, 60 * 5);
    expect(await checkoutService.pending(user.id)).toBeNull();

    const stillThere = await prisma.subscription.findUnique({
      where: { id: subscription.id },
    });
    expect(stillThere).not.toBeNull();
  });

  it('stops reporting one that has become a real subscription', async () => {
    const user = await createUser();
    const subscription = await startedCheckout(user.id);

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'ACTIVE',
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });

    const plan = await billingService.getPlan(user.id);

    // The signal hands over cleanly: pending goes, subscription arrives.
    expect(plan.pendingCheckout).toBeNull();
    expect(plan.subscription?.id).toBe(subscription.id);
    expect(plan.tier).toBe('PREMIUM');
  });

  it('reports the most recent attempt when there are several', async () => {
    const user = await createUser();
    const older = await startedCheckout(user.id, MONTHLY);
    const newer = await startedCheckout(user.id, ANNUAL);

    await age(older.id, 45);

    const pending = await checkoutService.pending(user.id);

    expect(pending?.subscriptionId).toBe(newer.id);
    expect(pending?.priceId).toBe(ANNUAL);
  });

  it('never reports one account’s checkout to another', async () => {
    const payer = await createUser();
    const bystander = await createUser();
    await startedCheckout(payer.id);

    expect(await checkoutService.pending(payer.id)).not.toBeNull();
    expect(await checkoutService.pending(bystander.id)).toBeNull();

    const plan = await billingService.getPlan(bystander.id);
    expect(plan.pendingCheckout).toBeNull();
  });
});

describe('a real checkout produces a visible pending state', () => {
  let stub: PaystackStub;
  let originalBaseUrl: string;

  beforeEach(async () => {
    stub = await startPaystackStub();
    originalBaseUrl = env.PAYSTACK_BASE_URL;
    // Read when an adapter is constructed, so this has to be set first.
    (env as any).PAYSTACK_BASE_URL = stub.baseUrl;
    providerRegistry.register(createPaystackAdapter(TEST_KEY));
  });

  afterEach(async () => {
    (env as any).PAYSTACK_BASE_URL = originalBaseUrl;
    await stub.close();
  });

  it('shows up on the plan the moment checkout starts, before any webhook', async () => {
    const user = await createUser();

    const session = await checkoutService.start({ userId: user.id, priceId: MONTHLY });
    const plan = await billingService.getPlan(user.id);

    expect(plan.pendingCheckout?.subscriptionId).toBe(session.subscriptionId);
    expect(plan.pendingCheckout?.priceId).toBe(MONTHLY);
    // Nothing has been granted — the money has not moved yet.
    expect(plan.tier).toBe('FREE');
  });
});

/**
 * These two run in order and mean nothing apart — which is the point. The
 * property under test is that state does not survive from the first into the
 * second, and the only way to see that is to put something in and look again.
 */
describe('a registered provider does not leak into the next test', () => {
  it('is configured while a test has registered one', () => {
    providerRegistry.register(createPaystackAdapter(TEST_KEY));
    expect(providerRegistry.isConfigured).toBe(true);
  });

  it('is back to nothing configured by the next', () => {
    expect(providerRegistry.isConfigured).toBe(false);
  });
});

describe('what Premium is can be read without an account', () => {
  it('answers a caller carrying no credentials at all', async () => {
    const res = await request(app).get('/api/v1/billing/tiers');

    expect(res.status).toBe(200);

    const tiers = res.body.data.tiers;
    expect(Array.isArray(tiers)).toBe(true);

    const premium = tiers.find((t: any) => t.tier === 'PREMIUM');
    expect(premium.name).toBeTruthy();
    expect(premium.includes.length).toBeGreaterThan(0);
    // The prices, with the per-month and saving figures worked out server-side
    // so every surface shows the same number.
    expect(premium.prices.length).toBeGreaterThan(0);
    expect(premium.prices[0]).toMatchObject({
      id: expect.any(String),
      amountMinor: expect.any(Number),
      currency: expect.any(String),
      perMonthMinor: expect.any(Number),
    });
    // Deterministically false now that the registry is reset between tests:
    // nothing in this test configured a provider.
    expect(res.body.data.checkoutAvailable).toBe(false);
  });

  it('tells an anonymous caller nothing about any account', async () => {
    // Populated on purpose: a real subscriber exists while this is read, so a
    // leak would have something to leak.
    const subscriber = await createUser();
    await startedCheckout(subscriber.id);
    await billingService.setPlan({
      userId: subscriber.id,
      tier: 'PREMIUM',
      actorUserId: subscriber.id,
      basis: 'test',
    });

    const res = await request(app).get('/api/v1/billing/tiers');

    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('tier');
    expect(res.body.data).not.toHaveProperty('subscription');
    expect(res.body.data).not.toHaveProperty('pendingCheckout');
    expect(res.body.data).not.toHaveProperty('entitlements');
    expect(res.body.data).not.toHaveProperty('entitlementSource');
  });

  it('still refuses an anonymous caller the account-specific plan', async () => {
    const res = await request(app).get('/api/v1/billing/plan');

    expect(res.status).toBe(401);
  });

  it('keeps serving the whole payload to a signed-in caller', async () => {
    const user = await createUser();
    const subscription = await startedCheckout(user.id);

    const res = await request(app).get('/api/v1/billing/plan').set(...authHeader(user));

    expect(res.status).toBe(200);
    // Everything an existing client already read is still there…
    expect(res.body.data.tier).toBe('FREE');
    expect(res.body.data.entitlements).toBeDefined();
    expect(res.body.data.tiers.length).toBeGreaterThan(0);
    expect(res.body.data.checkoutUrl).toBeTruthy();
    // Deterministically false now that the registry is reset between tests:
    // nothing in this test configured a provider.
    expect(res.body.data.checkoutAvailable).toBe(false);
    // …plus the signal that was missing.
    expect(res.body.data.pendingCheckout.subscriptionId).toBe(subscription.id);
  });

  it('serves the same tier list to both endpoints', async () => {
    const user = await createUser();

    const anonymous = await request(app).get('/api/v1/billing/tiers');
    const signedIn = await request(app)
      .get('/api/v1/billing/plan')
      .set(...authHeader(user));

    expect(anonymous.body.data.tiers).toEqual(signedIn.body.data.tiers);
  });
});
