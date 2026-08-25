import request from 'supertest';
import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import { billingService } from '@/modules/billing/billing.service';
import { personMembershipService } from '@/modules/person/person.membership.service';
import { quotaService } from '@/modules/usage/quota.service';
import { createUser, authHeader } from './helpers/factories';

/**
 * PlanType — the billing tier on User, not CarePlan.
 *
 * Until now nothing wrote it, so every account was FREE forever: the meter was
 * built and the door never was.
 */

const app = createApp();

describe('the tier can now be written, and grants entitlement', () => {
  it('starts every account on FREE with nothing granted', async () => {
    const user = await createUser();

    const res = await request(app).get('/api/v1/billing/plan').set(...authHeader(user));

    expect(res.status).toBe(200);
    expect(res.body.data.tier).toBe('FREE');
    expect(res.body.data.entitlements).toEqual({
      managedPersonLimit: 0,
      connectionLimit: 0,
    });
  });

  it('grants both capacity axes on upgrade', async () => {
    const user = await createUser();

    await billingService.setPlan({
      userId: user.id,
      tier: 'PREMIUM',
      actorUserId: user.id,
      basis: 'test',
    });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.planType).toBe('PREMIUM');
    // Two independent axes, both granted.
    expect(row.managedPersonLimit).toBeGreaterThan(0);
    expect(row.connectionLimit).toBeGreaterThan(0);
  });

  it('turns a refused action into an allowed one', async () => {
    const user = await createUser();

    // Free tier manages nobody, and this path has no baby exemption.
    await expect(
      personMembershipService.createManagedPerson(user.id, { displayName: 'Grandma' }),
    ).rejects.toMatchObject({ errorCode: 'BAD_REQUEST' });

    await billingService.setPlan({
      userId: user.id,
      tier: 'PREMIUM',
      actorUserId: user.id,
      basis: 'test',
    });

    await expect(
      personMembershipService.createManagedPerson(user.id, { displayName: 'Grandma' }),
    ).resolves.toBeTruthy();
  });

  it('refuses a redundant change and an erased account', async () => {
    const user = await createUser();

    await expect(
      billingService.setPlan({
        userId: user.id,
        tier: 'FREE',
        actorUserId: user.id,
        basis: 'test',
      }),
    ).rejects.toMatchObject({ errorCode: 'CONFLICT' });

    await prisma.user.update({
      where: { id: user.id },
      data: { erasedAt: new Date(), email: `erased-${user.id}@invalid` },
    });

    await expect(
      billingService.setPlan({
        userId: user.id,
        tier: 'PREMIUM',
        actorUserId: user.id,
        basis: 'test',
      }),
    ).rejects.toMatchObject({ errorCode: 'CONFLICT' });
  });
});

describe('downgrade is a ceiling on new, never a confiscation', () => {
  it('keeps every Person already held', async () => {
    const user = await createUser();
    await billingService.setPlan({
      userId: user.id,
      tier: 'PREMIUM',
      actorUserId: user.id,
      basis: 'test',
    });

    await personMembershipService.createManagedPerson(user.id, { displayName: 'Grandma' });
    await personMembershipService.createManagedPerson(user.id, { displayName: 'Uncle' });

    await billingService.setPlan({
      userId: user.id,
      tier: 'FREE',
      actorUserId: user.id,
      basis: 'lapsed',
    });

    // Both records survive and stay fully readable — health data must never
    // go read-only because a subscription lapsed.
    const people = await personMembershipService.listForAccount(user.id);
    const names = people.map(p => p.displayName);
    expect(names).toContain('Grandma');
    expect(names).toContain('Uncle');

    // Only *new* ones are refused.
    await expect(
      personMembershipService.createManagedPerson(user.id, { displayName: 'Aunt' }),
    ).rejects.toMatchObject({ errorCode: 'BAD_REQUEST' });
  });
});

describe('quota reflects the tier, not the token', () => {
  it('reports premium limits on the dashboard immediately after upgrade', async () => {
    const user = await createUser();

    const before = await request(app).get('/api/v1/dashboard').set(...authHeader(user));
    const freeLimit = before.body.data.account.usageSummary.symptomChecksLimit;

    await billingService.setPlan({
      userId: user.id,
      tier: 'PREMIUM',
      actorUserId: user.id,
      basis: 'test',
    });

    // Same token — it still says FREE inside. The limit shown must not.
    const after = await request(app).get('/api/v1/dashboard').set(...authHeader(user));
    const premiumLimit = after.body.data.account.usageSummary.symptomChecksLimit;

    expect(premiumLimit).toBeGreaterThan(freeLimit);
  });

  it('enforces the premium allowance on the same stale token', async () => {
    const user = await createUser();
    await billingService.setPlan({
      userId: user.id,
      tier: 'PREMIUM',
      actorUserId: user.id,
      basis: 'test',
    });

    // Spend past what FREE would allow. A token-derived limit would have
    // refused here — the "I paid and nothing happened" bug.
    for (let i = 0; i < 5; i += 1) {
      await expect(
        quotaService.checkAndIncrement(user.id, 'symptomCheck'),
      ).resolves.toBeUndefined();
    }

    const usage = await quotaService.getUsage(user.id);
    expect(usage.symptomChecks.used).toBe(5);
    expect(usage.symptomChecks.limit).toBeGreaterThan(5);
  });
});

describe('the write path is not open to anyone', () => {
  it('refuses a non-admin setting a tier', async () => {
    const user = await createUser();
    const other = await createUser();

    const res = await request(app)
      .patch(`/api/v1/billing/users/${other.id}/plan`)
      .set(...authHeader(user))
      .send({ tier: 'PREMIUM' });

    expect(res.status).toBe(403);

    const untouched = await prisma.user.findUniqueOrThrow({ where: { id: other.id } });
    expect(untouched.planType).toBe('FREE');
  });

  it('lets an admin set one', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const user = await createUser();

    const res = await request(app)
      .patch(`/api/v1/billing/users/${user.id}/plan`)
      .set(...authHeader(admin))
      .send({ tier: 'PREMIUM', basis: 'manual-grant' });

    expect(res.status).toBe(200);
    expect(res.body.data.planType).toBe('PREMIUM');
  });
});

describe('purchase happens on the web', () => {
  it('offers an absolute checkout URL outside the app', async () => {
    const user = await createUser();
    const res = await request(app).get('/api/v1/billing/plan').set(...authHeader(user));

    // Absolute, so a wrapped build opens a browser rather than rendering it
    // in-app — which is what keeps it out of store billing.
    expect(res.body.data.checkoutUrl).toMatch(/^https?:\/\//);
    expect(res.body.data.tiers).toHaveLength(2);
  });
});
