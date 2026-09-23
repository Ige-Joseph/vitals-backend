import request from 'supertest';
import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import { createUser, authHeader } from './helpers/factories';

/**
 * Leaving is not the same as being removed.
 *
 * Someone who shares their record with you can revoke you at any time. You
 * must equally be able to walk away — requiring `manage` to leave would mean
 * asking the owner's permission to stop holding their health data.
 */

const app = createApp();

/** An adult who has their own account and shares it with someone. */
async function connect(
  owner: { id: string; personId: string },
  member: { id: string },
  role: 'CAREGIVER' | 'VIEWER' = 'CAREGIVER',
) {
  return prisma.personMembership.create({
    data: {
      personId: owner.personId,
      userId: member.id,
      role,
      status: 'ACTIVE',
      acceptedAt: new Date(),
    },
  });
}

describe('a member may always end their own membership', () => {
  it('lets a CAREGIVER disconnect themselves', async () => {
    const owner = await createUser();
    const carer = await createUser();
    await connect(owner, carer);

    await request(app)
      .get(`/api/v1/dashboard?personId=${owner.personId}`)
      .set(...authHeader(carer))
      .expect(200);

    // No `manage` capability, and none needed to leave.
    await request(app)
      .delete(`/api/v1/persons/${owner.personId}/members/${carer.id}`)
      .set(...authHeader(carer))
      .expect(200);

    // Same token, no refresh.
    await request(app)
      .get(`/api/v1/dashboard?personId=${owner.personId}`)
      .set(...authHeader(carer))
      .expect(403);
  });

  it('lets a VIEWER disconnect themselves', async () => {
    const owner = await createUser();
    const viewer = await createUser();
    await connect(owner, viewer, 'VIEWER');

    await request(app)
      .delete(`/api/v1/persons/${owner.personId}/members/${viewer.id}`)
      .set(...authHeader(viewer))
      .expect(200);

    const membership = await prisma.personMembership.findUniqueOrThrow({
      where: { personId_userId: { personId: owner.personId, userId: viewer.id } },
    });
    expect(membership.status).toBe('REVOKED');
    expect(membership.revokedAt).not.toBeNull();
  });

  it('records leaving as LEFT, not REVOKED', async () => {
    const owner = await createUser();
    const carer = await createUser();
    await connect(owner, carer);

    await request(app)
      .delete(`/api/v1/persons/${owner.personId}/members/${carer.id}`)
      .set(...authHeader(carer))
      .expect(200);

    const events = await prisma.personAccessEvent.findMany({
      where: { personId: owner.personId, subjectUserId: carer.id },
    });

    // Who ended the relationship is a fact about consent, not an
    // implementation detail.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'LEFT',
      basis: 'self-revoke',
      actorUserId: carer.id,
    });
  });

  it('records an owner removing someone as REVOKED', async () => {
    const owner = await createUser();
    const carer = await createUser();
    await connect(owner, carer);

    await request(app)
      .delete(`/api/v1/persons/${owner.personId}/members/${carer.id}`)
      .set(...authHeader(owner))
      .expect(200);

    const events = await prisma.personAccessEvent.findMany({
      where: { personId: owner.personId, subjectUserId: carer.id },
    });
    expect(events[0]).toMatchObject({
      action: 'REVOKED',
      basis: 'owner-revoke',
      actorUserId: owner.id,
    });
  });
});

describe('revoking someone else still needs manage', () => {
  it('refuses a CAREGIVER removing another member', async () => {
    const owner = await createUser();
    const carer = await createUser();
    const viewer = await createUser();
    await connect(owner, carer);
    await connect(owner, viewer, 'VIEWER');

    await request(app)
      .delete(`/api/v1/persons/${owner.personId}/members/${viewer.id}`)
      .set(...authHeader(carer))
      .expect(403);

    const survived = await prisma.personMembership.findUniqueOrThrow({
      where: { personId_userId: { personId: owner.personId, userId: viewer.id } },
    });
    expect(survived.status).toBe('ACTIVE');
  });

  it('refuses a stranger entirely', async () => {
    const owner = await createUser();
    const carer = await createUser();
    const stranger = await createUser();
    await connect(owner, carer);

    await request(app)
      .delete(`/api/v1/persons/${owner.personId}/members/${carer.id}`)
      .set(...authHeader(stranger))
      .expect(403);
  });
});

describe('the last owner still cannot be revoked', () => {
  it('refuses an owner leaving their own record', async () => {
    const owner = await createUser();

    // Self-revoke does not become an escape hatch around stranding a record.
    const res = await request(app)
      .delete(`/api/v1/persons/${owner.personId}/members/${owner.id}`)
      .set(...authHeader(owner));

    expect(res.status).toBe(409);

    const membership = await prisma.personMembership.findUniqueOrThrow({
      where: { personId_userId: { personId: owner.personId, userId: owner.id } },
    });
    expect(membership.status).toBe('ACTIVE');
  });

  it('allows an owner to leave once another owner exists', async () => {
    const owner = await createUser();
    const coOwner = await createUser();

    await prisma.personMembership.create({
      data: {
        personId: owner.personId,
        userId: coOwner.id,
        role: 'OWNER',
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });

    await request(app)
      .delete(`/api/v1/persons/${owner.personId}/members/${owner.id}`)
      .set(...authHeader(owner))
      .expect(200);
  });
});

describe('the dashboard reports the real relationship', () => {
  it('distinguishes self, managed and connected', async () => {
    const me = await createUser();
    const friend = await createUser();

    // A dependent with no account of their own.
    const baby = await prisma.person.create({
      data: { displayName: 'Ada', createdByUserId: me.id, origin: 'DELIVERY' },
    });
    await prisma.personMembership.create({
      data: {
        personId: baby.id,
        userId: me.id,
        role: 'OWNER',
        status: 'ACTIVE',
        receivesNotifications: true,
        acceptedAt: new Date(),
      },
    });

    // An adult who shared their own record with me.
    await connect(friend, me, 'CAREGIVER');

    const res = await request(app).get('/api/v1/dashboard').set(...authHeader(me));
    expect(res.status).toBe(200);

    const byName: Record<string, any> = Object.fromEntries(
      res.body.data.people.map((p: any) => [p.displayName, p]),
    );

    expect(byName[baby.displayName].relationship).toBe('managed');
    expect(byName[baby.displayName].isClaimed).toBe(false);

    // This is the case that used to report "managed", which was false.
    const friendEntry = res.body.data.people.find(
      (p: any) => p.personId === friend.personId,
    );
    expect(friendEntry.relationship).toBe('connected');
    expect(friendEntry.isClaimed).toBe(true);

    const own = res.body.data.people.find((p: any) => p.personId === me.personId);
    expect(own.relationship).toBe('self');
    expect(own.isClaimed).toBe(true);
  });
});
