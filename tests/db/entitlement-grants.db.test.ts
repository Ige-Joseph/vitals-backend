import request from 'supertest';

import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import { billingService } from '@/modules/billing/billing.service';
import { grantService } from '@/modules/billing/grant.service';
import { entitlementService } from '@/modules/billing/entitlement.service';
import { createUser, authHeader, type TestUser } from './helpers/factories';

/**
 * Premium given rather than bought.
 *
 * The properties worth proving are the ones a column could not express:
 * that a grant stops on its own when its time passes, that revoking is
 * recorded rather than erased, that a grant and a subscription coexist without
 * either erasing the other, and that none of it can be reached by a user.
 *
 * Expiry is the one to look at hardest. Nothing sweeps these rows, so a grant
 * that has run out must stop granting because the resolver says so — not
 * because a job got round to marking it.
 */

const app = createApp();

const MONTHLY = 'premium-monthly-2026-08';
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);

async function subscribe(userId: string, overrides: Partial<{ status: 'ACTIVE' | 'EXPIRED'; currentPeriodEnd: Date }> = {}) {
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

/** A grant written directly, so a past expiry can be set without the guard. */
const seedGrant = (
  userId: string,
  overrides: Partial<{ expiresAt: Date | null; status: 'ACTIVE' | 'REVOKED' }> = {},
) =>
  prisma.entitlementGrant.create({
    data: {
      userId,
      tier: 'PREMIUM',
      source: 'ADMIN',
      reason: 'test',
      expiresAt: overrides.expiresAt ?? null,
      status: overrides.status ?? 'ACTIVE',
    },
  });

const requestReport = (user: TestUser) =>
  request(app).post('/api/v1/reports/health-summary').set(...authHeader(user)).send({});

const planFor = (user: TestUser) =>
  request(app).get('/api/v1/billing/plan').set(...authHeader(user));

const setPlan = (
  actor: TestUser,
  targetId: string,
  body: Record<string, unknown>,
) =>
  request(app)
    .patch(`/api/v1/billing/users/${targetId}/plan`)
    .set(...authHeader(actor))
    .send(body);

describe('a grant decides entitlement', () => {
  it('an active grant makes an account Premium', async () => {
    const user = await createUser();
    await seedGrant(user.id);

    expect(await entitlementService.tierFor(user.id)).toBe('PREMIUM');
    expect((await planFor(user)).body.data.tier).toBe('PREMIUM');
    expect((await requestReport(user)).status).toBe(202);
  });

  it('an expired grant does not, with nothing having swept it', async () => {
    const user = await createUser();
    const grant = await seedGrant(user.id, { expiresAt: inDays(-1) });

    // The row still says ACTIVE. Nothing has run. It must still not grant.
    const row = await prisma.entitlementGrant.findUniqueOrThrow({ where: { id: grant.id } });
    expect(row.status).toBe('ACTIVE');

    expect(await entitlementService.tierFor(user.id)).toBe('FREE');
    expect((await planFor(user)).body.data.tier).toBe('FREE');
    expect((await requestReport(user)).status).toBe(403);
  });

  it('stops granting the moment the expiry passes', async () => {
    const user = await createUser();
    await seedGrant(user.id, { expiresAt: new Date(Date.now() + 1200) });

    expect(await entitlementService.tierFor(user.id)).toBe('PREMIUM');

    await new Promise(resolve => setTimeout(resolve, 1500));

    expect(await entitlementService.tierFor(user.id)).toBe('FREE');
  });

  it('a revoked grant does not', async () => {
    const user = await createUser();
    await seedGrant(user.id, { status: 'REVOKED' });

    expect(await entitlementService.tierFor(user.id)).toBe('FREE');
    expect((await requestReport(user)).status).toBe(403);
  });

  it('a grant with no expiry runs until revoked', async () => {
    const user = await createUser();
    await seedGrant(user.id, { expiresAt: null });

    expect(await entitlementService.tierFor(user.id)).toBe('PREMIUM');
  });
});

describe('a grant and a subscription are independent', () => {
  it('reports the subscription as the source when both are Premium', async () => {
    const user = await createUser();
    await seedGrant(user.id);
    await subscribe(user.id);

    const entitlement = await entitlementService.effective(user.id);
    expect(entitlement.tier).toBe('PREMIUM');
    expect(entitlement.source).toBe('subscription');
    expect(entitlement.grant).not.toBeNull();
  });

  it('keeps the grant effective when the subscription lapses', async () => {
    const user = await createUser();
    await seedGrant(user.id);
    const sub = await subscribe(user.id);

    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: 'EXPIRED', currentPeriodEnd: inDays(-1) },
    });

    // A failed card must not remove something nobody paid for.
    const entitlement = await entitlementService.effective(user.id);
    expect(entitlement.tier).toBe('PREMIUM');
    expect(entitlement.source).toBe('grant');
    expect((await requestReport(user)).status).toBe(202);
  });

  it('keeps the subscription when the grant is revoked', async () => {
    const user = await createUser();
    await subscribe(user.id);
    await seedGrant(user.id);

    await grantService.revoke({ userId: user.id, reason: 'no longer needed', actorUserId: user.id });

    expect((await planFor(user)).body.data.tier).toBe('PREMIUM');
    expect((await requestReport(user)).status).toBe(202);
  });

  it('an expired grant with an active subscription is still Premium', async () => {
    const user = await createUser();
    await seedGrant(user.id, { expiresAt: inDays(-1) });
    await subscribe(user.id);

    expect((await planFor(user)).body.data.tier).toBe('PREMIUM');
  });
});

describe('granting and revoking are recorded', () => {
  it('records who granted it, why, and until when', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const target = await createUser();
    const expiry = inDays(30);

    const res = await setPlan(admin, target.id, {
      tier: 'PREMIUM',
      basis: 'Pilot programme',
      expiresAt: expiry.toISOString(),
    });
    expect(res.status).toBe(200);

    const grant = await prisma.entitlementGrant.findFirstOrThrow({ where: { userId: target.id } });
    expect(grant.grantedByUserId).toBe(admin.id);
    expect(grant.reason).toBe('Pilot programme');
    expect(grant.status).toBe('ACTIVE');
    expect(grant.expiresAt?.toISOString().slice(0, 10)).toBe(expiry.toISOString().slice(0, 10));
  });

  it('records who revoked it and why, keeping the row', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const target = await createUser();

    await setPlan(admin, target.id, { tier: 'PREMIUM', basis: 'trial' });
    await setPlan(admin, target.id, { tier: 'FREE', basis: 'trial ended' });

    const grant = await prisma.entitlementGrant.findFirstOrThrow({ where: { userId: target.id } });
    expect(grant.status).toBe('REVOKED');
    expect(grant.revokedByUserId).toBe(admin.id);
    expect(grant.revokedReason).toBe('trial ended');
    // The history survives the revocation.
    expect(grant.reason).toBe('trial');
    expect(await prisma.entitlementGrant.count({ where: { userId: target.id } })).toBe(1);
  });

  it('keeps the planType projection in step with the resolver', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const target = await createUser();

    await setPlan(admin, target.id, { tier: 'PREMIUM', basis: 'grant' });
    let user = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(user.planType).toBe('PREMIUM');
    expect(await entitlementService.tierFor(target.id)).toBe('PREMIUM');

    await setPlan(admin, target.id, { tier: 'FREE', basis: 'revoked' });
    user = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(user.planType).toBe('FREE');
    expect(await entitlementService.tierFor(target.id)).toBe('FREE');
  });

  it('refuses a second grant while one is running', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const target = await createUser();

    await setPlan(admin, target.id, { tier: 'PREMIUM', basis: 'first' });
    const second = await setPlan(admin, target.id, { tier: 'PREMIUM', basis: 'second' });

    expect(second.status).toBe(409);
    expect(await prisma.entitlementGrant.count({ where: { userId: target.id } })).toBe(1);
  });

  it('refuses to revoke when nothing is running', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const target = await createUser();

    expect((await setPlan(admin, target.id, { tier: 'FREE', basis: 'nothing to revoke' })).status).toBe(409);
  });

  it('refuses an expiry in the past', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const target = await createUser();

    const res = await setPlan(admin, target.id, {
      tier: 'PREMIUM',
      basis: 'backdated',
      expiresAt: inDays(-1).toISOString(),
    });

    expect(res.status).toBe(400);
    expect(await prisma.entitlementGrant.count({ where: { userId: target.id } })).toBe(0);
  });

  it('does not touch the subscription when revoking', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const target = await createUser();
    const sub = await subscribe(target.id);
    await setPlan(admin, target.id, { tier: 'PREMIUM', basis: 'extra' });

    await setPlan(admin, target.id, { tier: 'FREE', basis: 'revoked' });

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('ACTIVE');
    expect(after.endedAt).toBeNull();
  });
});

describe('only admins may touch entitlement', () => {
  it('an ordinary user cannot grant', async () => {
    const user = await createUser();
    const target = await createUser();

    expect((await setPlan(user, target.id, { tier: 'PREMIUM', basis: 'nice try' })).status).toBe(403);
    expect(await prisma.entitlementGrant.count({ where: { userId: target.id } })).toBe(0);
  });

  it('an ordinary user cannot grant themselves Premium', async () => {
    const user = await createUser();

    expect((await setPlan(user, user.id, { tier: 'PREMIUM', basis: 'nice try' })).status).toBe(403);
    expect(await entitlementService.tierFor(user.id)).toBe('FREE');
    expect((await requestReport(user)).status).toBe(403);
  });

  it('an ordinary user cannot revoke someone else', async () => {
    const user = await createUser();
    const target = await createUser();
    await seedGrant(target.id);

    expect((await setPlan(user, target.id, { tier: 'FREE', basis: 'nice try' })).status).toBe(403);
    expect(await entitlementService.tierFor(target.id)).toBe('PREMIUM');
  });

  it('an unauthenticated caller cannot grant', async () => {
    const target = await createUser();

    const res = await request(app)
      .patch(`/api/v1/billing/users/${target.id}/plan`)
      .send({ tier: 'PREMIUM', basis: 'nice try' });

    expect(res.status).toBe(401);
  });

  it('refuses an ordinary user the entitlement overview', async () => {
    const user = await createUser();
    const target = await createUser();

    const res = await request(app)
      .get(`/api/v1/billing/users/${target.id}/entitlement`)
      .set(...authHeader(user));

    expect(res.status).toBe(403);
  });
});

describe('the admin entitlement overview', () => {
  it('shows the effective tier, its source, the active grant and the history', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const target = await createUser();

    await setPlan(admin, target.id, { tier: 'PREMIUM', basis: 'first grant' });
    await setPlan(admin, target.id, { tier: 'FREE', basis: 'withdrawn' });
    await setPlan(admin, target.id, { tier: 'PREMIUM', basis: 'second grant' });

    const res = await request(app)
      .get(`/api/v1/billing/users/${target.id}/entitlement`)
      .set(...authHeader(admin));

    expect(res.status).toBe(200);
    const body = res.body.data;

    expect(body.effective.tier).toBe('PREMIUM');
    expect(body.effective.source).toBe('grant');
    expect(body.subscription).toBeNull();
    expect(body.activeGrant.reason).toBe('second grant');
    expect(body.history).toHaveLength(2);
    // The projection is exposed so a drift from `effective` is visible.
    expect(body.planTypeProjection).toBe('PREMIUM');
    // Who did it survives in the history.
    expect(body.history[0].grantedBy.email).toBe(admin.email);
  });

  it('distinguishes a subscription from a grant', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const target = await createUser();
    await subscribe(target.id);

    const res = await request(app)
      .get(`/api/v1/billing/users/${target.id}/entitlement`)
      .set(...authHeader(admin));

    expect(res.body.data.effective.source).toBe('subscription');
    expect(res.body.data.subscription).not.toBeNull();
    expect(res.body.data.activeGrant).toBeNull();
  });
});
