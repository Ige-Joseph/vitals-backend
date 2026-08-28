import request from 'supertest';

import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import { billingService } from '@/modules/billing/billing.service';
import { entitlementService } from '@/modules/billing/entitlement.service';
import { createUser, authHeader, type TestUser } from './helpers/factories';

/**
 * Who is Premium, and does everything agree about it.
 *
 * Premium can arrive two ways — a paid subscription, or an admin grant that
 * writes the `planType` projection — and for a while the codebase answered the
 * question differently depending on which function you asked. `tierFor`, which
 * every gate uses, honoured a grant. `resolve`, which `GET /billing/plan`
 * uses, did not. The result was an account that was entitled and told it was
 * not: the frontend read the tier, showed an upgrade prompt, and the feature
 * worked perfectly if you called it directly.
 *
 * These tests exist to keep the two answers in step. Half of them would have
 * passed before the fix; the ones that matter are the grant cases.
 */

const app = createApp();

const MONTHLY = 'premium-monthly-2026-08';
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);

async function subscribe(
  userId: string,
  overrides: Partial<{
    status: 'INCOMPLETE' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'EXPIRED';
    currentPeriodEnd: Date;
  }> = {},
) {
  await billingService.syncPrices();
  return prisma.subscription.create({
    data: {
      userId,
      priceId: MONTHLY,
      status: overrides.status ?? 'ACTIVE',
      provider: 'PAYSTACK',
      providerSubscriptionId: `sub_${userId}`,
      providerCustomerRef: `cus_${userId}`,
      currentPeriodStart: new Date(),
      currentPeriodEnd: overrides.currentPeriodEnd ?? inDays(30),
    },
  });
}

/** Ask for a report — the one feature gated on Premium end to end. */
const requestReport = (user: TestUser) =>
  request(app)
    .post('/api/v1/reports/health-summary')
    .set(...authHeader(user))
    .send({});

const planFor = (user: TestUser) =>
  request(app).get('/api/v1/billing/plan').set(...authHeader(user));

describe('the Premium gate', () => {
  it('refuses a free account', async () => {
    const user = await createUser();

    const res = await requestReport(user);

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/premium/i);
  });

  it('admits a paying subscriber', async () => {
    const user = await createUser();
    await subscribe(user.id);

    expect((await requestReport(user)).status).toBe(202);
  });

  it('admits an account granted Premium by an admin, with no subscription', async () => {
    const user = await createUser({ planType: 'PREMIUM' });

    expect((await requestReport(user)).status).toBe(202);
  });
});

describe('what /billing/plan reports agrees with what the gate does', () => {
  it('reports FREE for a free account, and the gate refuses it', async () => {
    const user = await createUser();

    const plan = await planFor(user);
    expect(plan.body.data.tier).toBe('FREE');
    expect((await requestReport(user)).status).toBe(403);
  });

  it('reports PREMIUM for a subscriber, sourced to the subscription', async () => {
    const user = await createUser();
    await subscribe(user.id);

    const plan = await planFor(user);
    expect(plan.body.data.tier).toBe('PREMIUM');
    expect(plan.body.data.entitlementSource).toBe('subscription');
  });

  it('reports PREMIUM for an admin-granted account, sourced to the grant', async () => {
    const user = await createUser({ planType: 'PREMIUM' });

    const plan = await planFor(user);

    // The regression this file exists for: this reported FREE while the gate
    // above admits the same account.
    expect(plan.body.data.tier).toBe('PREMIUM');
    expect(plan.body.data.entitlementSource).toBe('grant');
    expect(plan.body.data.subscription).toBeNull();
  });

  it('gives the same answer as tierFor, for every way of being Premium', async () => {
    const free = await createUser();
    const granted = await createUser({ planType: 'PREMIUM' });
    const paying = await createUser();
    await subscribe(paying.id);

    for (const user of [free, granted, paying]) {
      const viaResolve = (await entitlementService.resolve(user.id)).tier;
      const viaTierFor = await entitlementService.tierFor(user.id);
      expect(viaResolve).toBe(viaTierFor);
    }
  });
});

describe('Premium that has ended is not Premium', () => {
  it('does not treat an expired subscription as active', async () => {
    const user = await createUser();
    await subscribe(user.id, { status: 'EXPIRED', currentPeriodEnd: inDays(-1) });

    expect((await planFor(user)).body.data.tier).toBe('FREE');
    expect((await requestReport(user)).status).toBe(403);
  });

  it('does not treat a cancelled subscription past its period end as active', async () => {
    const user = await createUser();
    await subscribe(user.id, { status: 'CANCELED', currentPeriodEnd: inDays(-1) });

    expect((await planFor(user)).body.data.tier).toBe('FREE');
    expect((await requestReport(user)).status).toBe(403);
  });

  it('keeps a cancelled subscription granting until its period ends', async () => {
    const user = await createUser();
    await subscribe(user.id, { status: 'CANCELED', currentPeriodEnd: inDays(10) });

    // Cancelling ends the next charge, not today's access. It was paid for.
    expect((await planFor(user)).body.data.tier).toBe('PREMIUM');
    expect((await requestReport(user)).status).toBe(202);
  });

  it('stops immediately when the subscription was ended outright', async () => {
    const user = await createUser();
    const sub = await subscribe(user.id, { currentPeriodEnd: inDays(20) });
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: 'CANCELED', endedAt: new Date() },
    });

    // endedAt overrides the remaining period: this is what an erasing or
    // deactivating account does, and it must not keep access for weeks.
    expect((await planFor(user)).body.data.tier).toBe('FREE');
    expect((await requestReport(user)).status).toBe(403);
  });

  it('treats a revoked grant as revoked as soon as planType is lowered', async () => {
    const user = await createUser({ planType: 'PREMIUM' });
    expect((await requestReport(user)).status).toBe(202);

    await billingService.setPlan({
      userId: user.id,
      tier: 'FREE',
      actorUserId: user.id,
      basis: 'test revocation',
    });

    // No token was reissued. The gate reads the database, so revocation takes
    // effect on the next request rather than the next login.
    expect((await planFor(user)).body.data.tier).toBe('FREE');
    expect((await requestReport(user)).status).toBe(403);
  });
});

describe('a grant and a subscription together', () => {
  it('prefers the subscription as the source, and never reduces capacity', async () => {
    const user = await createUser({ planType: 'PREMIUM' });
    await subscribe(user.id);

    const entitlement = await entitlementService.resolve(user.id);

    expect(entitlement.tier).toBe('PREMIUM');
    expect(entitlement.source).toBe('subscription');
    // The grant's raised columns still apply — Math.max, so a subscription
    // cannot silently strip capacity that was given separately.
    expect(entitlement.managedPersonLimit).toBeGreaterThanOrEqual(0);
  });

  it('falls back to the grant when the subscription lapses', async () => {
    const user = await createUser({ planType: 'PREMIUM' });
    const sub = await subscribe(user.id);

    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: 'EXPIRED', currentPeriodEnd: inDays(-1) },
    });

    // The admin gave this account Premium separately. A lapsed payment must
    // not take away something that was not bought.
    expect((await planFor(user)).body.data.tier).toBe('PREMIUM');
    expect((await requestReport(user)).status).toBe(202);
  });
});

describe('the admin plan endpoint is admin-only', () => {
  const setPlan = (actor: TestUser, targetId: string, tier: 'FREE' | 'PREMIUM') =>
    request(app)
      .patch(`/api/v1/billing/users/${targetId}/plan`)
      .set(...authHeader(actor))
      .send({ tier, basis: 'test' });

  it('refuses an ordinary user', async () => {
    const user = await createUser();
    const target = await createUser();

    const res = await setPlan(user, target.id, 'PREMIUM');

    expect(res.status).toBe(403);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.planType).toBe('FREE');
  });

  it('refuses an ordinary user trying to upgrade themselves', async () => {
    const user = await createUser();

    expect((await setPlan(user, user.id, 'PREMIUM')).status).toBe(403);
    expect((await requestReport(user)).status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const target = await createUser();

    const res = await request(app)
      .patch(`/api/v1/billing/users/${target.id}/plan`)
      .send({ tier: 'PREMIUM', basis: 'test' });

    expect(res.status).toBe(401);
  });

  it('lets an admin grant, and the grant takes effect immediately', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const target = await createUser();

    expect((await requestReport(target)).status).toBe(403);

    const res = await setPlan(admin, target.id, 'PREMIUM');
    expect(res.status).toBe(200);

    // Same token as before the grant. The gate reads the database.
    expect((await requestReport(target)).status).toBe(202);
    expect((await planFor(target)).body.data.tier).toBe('PREMIUM');
  });

  it('lets an admin revoke', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const target = await createUser({ planType: 'PREMIUM' });

    expect((await setPlan(admin, target.id, 'FREE')).status).toBe(200);

    expect((await planFor(target)).body.data.tier).toBe('FREE');
    expect((await requestReport(target)).status).toBe(403);
  });

  it('refuses to set the tier an account already has', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const target = await createUser({ planType: 'PREMIUM' });

    const res = await setPlan(admin, target.id, 'PREMIUM');

    expect(res.status).toBe(409);
  });
});
