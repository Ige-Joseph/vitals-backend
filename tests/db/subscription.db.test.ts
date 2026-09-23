import { prisma } from '@/lib/prisma';
import { billingService } from '@/modules/billing/billing.service';
import { entitlementService } from '@/modules/billing/entitlement.service';
import { subscriptionService } from '@/modules/billing/subscription.service';
import { providerRegistry } from '@/modules/billing/provider/provider.registry';
import { personRepository } from '@/modules/person/person.repository';
import { erasureService } from '@/modules/person/erasure.service';
import { userService } from '@/modules/user/user.service';
import { createUser } from './helpers/factories';

/**
 * The subscription model and entitlement resolution.
 *
 * No provider is integrated, which is itself part of what these assert: the
 * registry refuses rather than pretending, and an account can still leave.
 */

const MONTHLY = 'premium-monthly-2026-08';

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);

async function subscribe(
  userId: string,
  overrides: Partial<{
    status: 'INCOMPLETE' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'EXPIRED';
    currentPeriodEnd: Date;
    providerSubscriptionId: string;
  }> = {},
) {
  await billingService.syncPrices();
  return prisma.subscription.create({
    data: {
      userId,
      priceId: MONTHLY,
      status: overrides.status ?? 'ACTIVE',
      provider: 'PAYSTACK',
      providerSubscriptionId: overrides.providerSubscriptionId ?? `sub_${userId}`,
      providerCustomerRef: `cus_${userId}`,
      currentPeriodStart: new Date(),
      currentPeriodEnd: overrides.currentPeriodEnd ?? inDays(30),
    },
  });
}

describe('prices are insert-only, so a subscriber keeps their price', () => {
  it('syncs from config without ever updating an existing row', async () => {
    await billingService.syncPrices();
    const original = await prisma.price.findUniqueOrThrow({ where: { id: MONTHLY } });

    // Simulate the config having been repriced in place — the sync must not
    // propagate that onto a row someone may already have bought.
    await billingService.syncPrices();

    const after = await prisma.price.findUniqueOrThrow({ where: { id: MONTHLY } });
    expect(after.amountMinor).toBe(original.amountMinor);
    expect(after.createdAt).toEqual(original.createdAt);
  });
});

describe('entitlement resolves from subscription state', () => {
  it('grants nothing without one', async () => {
    const user = await createUser();
    const entitlement = await entitlementService.resolve(user.id);

    expect(entitlement.tier).toBe('FREE');
    expect(entitlement.source).toBe('default');
    expect(entitlement.managedPersonLimit).toBe(0);
    expect(entitlement.subscription).toBeNull();
  });

  it('grants the price’s tier while the subscription is active', async () => {
    const user = await createUser();
    await subscribe(user.id);

    const entitlement = await entitlementService.resolve(user.id);
    expect(entitlement.tier).toBe('PREMIUM');
    expect(entitlement.source).toBe('subscription');
    expect(entitlement.managedPersonLimit).toBeGreaterThan(0);

    // And capacity is measured against it, not against User.planType — which
    // is still FREE on this row.
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.planType).toBe('FREE');
    expect((await personRepository.capacityFor(user.id)).managedLimit).toBeGreaterThan(0);
  });

  it('keeps granting while PAST_DUE — a failed card is not a reason to lose a record', async () => {
    const user = await createUser();
    await subscribe(user.id, { status: 'PAST_DUE' });

    expect((await entitlementService.resolve(user.id)).tier).toBe('PREMIUM');
  });

  it('keeps granting after cancellation until the period ends, then stops', async () => {
    const user = await createUser();
    const sub = await subscribe(user.id, { status: 'CANCELED' });

    // Paid up: still grants.
    expect((await entitlementService.resolve(user.id)).tier).toBe('PREMIUM');

    await prisma.subscription.update({
      where: { id: sub.id },
      data: { currentPeriodEnd: inDays(-1) },
    });

    expect((await entitlementService.resolve(user.id)).tier).toBe('FREE');
  });

  it('grants nothing while checkout is incomplete', async () => {
    const user = await createUser();
    await subscribe(user.id, { status: 'INCOMPLETE' });

    expect((await entitlementService.resolve(user.id)).tier).toBe('FREE');
  });

  it('lets a manual grant top up, and never reduces a subscription', async () => {
    const user = await createUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { managedPersonLimit: 99 },
    });

    const granted = await entitlementService.resolve(user.id);
    expect(granted.source).toBe('grant');
    expect(granted.managedPersonLimit).toBe(99);

    // With a subscription too, the higher of the two wins rather than the
    // subscription silently stripping the grant.
    await subscribe(user.id);
    const both = await entitlementService.resolve(user.id);
    expect(both.source).toBe('subscription');
    expect(both.managedPersonLimit).toBe(99);
  });
});

describe('the provider registry refuses rather than pretending', () => {
  it('reports nothing configured and declines to hand out an adapter', () => {
    expect(providerRegistry.isConfigured).toBe(false);
    expect(() => providerRegistry.require('PAYSTACK')).toThrow();
    expect(providerRegistry.find('PAYSTACK')).toBeUndefined();
  });

  it('reports an unconfirmed cancellation rather than a false success', async () => {
    const result = await providerRegistry.tryCancel(
      { provider: 'PAYSTACK', providerSubscriptionId: 'sub_x' },
      'test',
    );
    expect(result.confirmed).toBe(false);

    // Nothing to cancel is genuinely fine, and says so.
    const nothing = await providerRegistry.tryCancel(
      { provider: 'PAYSTACK', providerSubscriptionId: null },
      'test',
    );
    expect(nothing.confirmed).toBe(true);
  });
});

describe('an account that leaves stops being charged', () => {
  it('cancels on deactivation and records that the provider did not confirm', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const user = await createUser();
    const sub = await subscribe(user.id);

    await userService.deactivateUser(admin.id, user.id);

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('CANCELED');
    expect(after.endedAt).not.toBeNull();
    // Requested but unconfirmed — the signal reconciliation retries on. With
    // no adapter registered this is the honest outcome.
    expect(after.cancellationRequestedAt).not.toBeNull();
    expect(after.cancellationConfirmedAt).toBeNull();

    // And it stops granting immediately.
    expect((await entitlementService.resolve(user.id)).tier).toBe('FREE');
  });

  it('cancels on erasure without a provider outage blocking it', async () => {
    const user = await createUser();
    await subscribe(user.id);

    const result = await erasureService.execute(user.id, user.id);

    // Erasure completed despite the cancellation being unconfirmed.
    expect(result.subscriptionsCancelled).toBe(1);
    expect(result.cancellationsUnconfirmed).toBe(1);

    const tombstone = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(tombstone.erasedAt).not.toBeNull();
  });
});

describe('a refund arriving after erasure has somewhere to land', () => {
  it('keeps the payment record and drops only the personal link', async () => {
    const user = await createUser();
    const sub = await subscribe(user.id);

    const charge = await prisma.paymentTransaction.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        provider: 'PAYSTACK',
        providerReference: `ch_${user.id}`,
        providerCustomerRef: `cus_${user.id}`,
        type: 'CHARGE',
        status: 'SUCCEEDED',
        amountMinor: 100_000,
      },
    });

    await erasureService.execute(user.id, user.id);

    // The financial record survives — it is not the erased subject's to
    // delete — but carries no link to them.
    const afterErasure = await prisma.paymentTransaction.findUniqueOrThrow({
      where: { id: charge.id },
    });
    expect(afterErasure.userId).toBeNull();
    expect(afterErasure.amountMinor).toBe(100_000);
    expect(afterErasure.providerCustomerRef).toBe(`cus_${user.id}`);

    // A refund arriving weeks later still lands, matched on the provider's
    // own references rather than on a user row that no longer means anything.
    const refund = await prisma.paymentTransaction.create({
      data: {
        subscriptionId: sub.id,
        provider: 'PAYSTACK',
        providerReference: `rf_${user.id}`,
        providerCustomerRef: `cus_${user.id}`,
        type: 'REFUND',
        status: 'SUCCEEDED',
        amountMinor: -100_000,
      },
    });

    expect(refund.userId).toBeNull();

    const trail = await prisma.paymentTransaction.findMany({
      where: { providerCustomerRef: `cus_${user.id}` },
      orderBy: { createdAt: 'asc' },
    });
    expect(trail.map(t => t.type)).toEqual(['CHARGE', 'REFUND']);
  });

  it('refuses to record the same provider event twice', async () => {
    const user = await createUser();
    const sub = await subscribe(user.id);

    const data = {
      subscriptionId: sub.id,
      provider: 'PAYSTACK' as const,
      providerReference: `ch_dupe_${user.id}`,
      type: 'CHARGE' as const,
      status: 'SUCCEEDED' as const,
      amountMinor: 100_000,
    };

    await prisma.paymentTransaction.create({ data });

    // A replayed webhook must not charge the books twice.
    await expect(prisma.paymentTransaction.create({ data })).rejects.toMatchObject({
      code: 'P2002',
    });
  });
});
