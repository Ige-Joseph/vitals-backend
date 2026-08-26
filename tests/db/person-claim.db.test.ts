import request from 'supertest';
import jwt from 'jsonwebtoken';

import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import { authService } from '@/modules/auth/auth.service';
import { personInvitationService } from '@/modules/person/person.invitation.service';
import { personClaimService } from '@/modules/person/person.claim.service';
import { personRepository } from '@/modules/person/person.repository';
import { createUser, authHeader } from './helpers/factories';

/**
 * Session 7, against real rows.
 *
 * Everything here is about which row holds `ownerUserId`, which memberships
 * survive a claim, and what the ledger says afterwards — none of which a
 * mocked Prisma client can answer. The suites under `tests/integration` mock
 * the client wholesale and could not catch a cross-person leak; these run the
 * actual `where` clauses.
 */

const app = createApp();

/** The raw token never leaves the service, so tests read it from the outbox. */
async function tokenFor(email: string): Promise<string> {
  const event = await prisma.outboxEvent.findFirstOrThrow({
    where: { type: 'PERSON_INVITATION' },
    orderBy: { createdAt: 'desc' },
  });
  const payload = event.payload as any;
  expect(payload.email).toBe(email.toLowerCase());
  return payload.rawToken as string;
}

/** A dependent: a record somebody set up about another person, unclaimed. */
async function createManagedPerson(managerUserId: string, name: string) {
  const person = await prisma.person.create({
    data: { displayName: name, createdByUserId: managerUserId, origin: 'MANAGED' },
  });

  await prisma.personMembership.create({
    data: {
      personId: person.id,
      userId: managerUserId,
      role: 'OWNER',
      status: 'ACTIVE',
      receivesNotifications: true,
      acceptedAt: new Date(),
    },
  });

  return person;
}

/** Populate a record the way a real one gets populated. */
async function populate(personId: string, userId: string) {
  await prisma.personHealthProfile.create({
    data: {
      personId,
      bloodGroup: 'O+',
      genotype: 'AA',
      allergies: ['penicillin'],
      existingConditions: ['asthma'],
    },
  });

  await prisma.symptomLog.create({
    data: { userId, personId, symptomsText: 'headache, shortness of breath', severity: 'MODERATE' },
  });

  const carePlan = await prisma.carePlan.create({
    data: {
      userId,
      personId,
      type: 'MEDICATION',
      title: 'Ventolin — 100mcg',
      status: 'ACTIVE',
      metadata: { frequency: 'TWICE_DAILY' },
      medication: {
        create: {
          name: 'Ventolin',
          dosage: '100mcg',
          frequency: 'TWICE_DAILY',
          startDate: new Date(),
        },
      },
    },
  });

  return { carePlanId: carePlan.id };
}

/** Sign up the way the application does, so the origin fix is under test. */
async function signup(email: string, firstName = 'Emma') {
  const result = await authService.signup({
    email,
    password: 'Correct-horse-9',
    firstName,
    lastName: 'Okafor',
  });

  // The invitation flow requires a verified address: accepting decides who
  // reads a health record, and an unverified address is an unproven claim to
  // an identity.
  await prisma.user.update({
    where: { id: result.user.id },
    data: { emailVerified: true },
  });

  return result.user;
}

// ────────────────────────────────────────────────────────────────────────
// The origin bug
// ────────────────────────────────────────────────────────────────────────

describe('an account’s own record says so', () => {
  it('signup writes origin SELF, not the column default', async () => {
    const user = await signup('ada@test.local', 'Ada');

    const person = await prisma.person.findFirstOrThrow({
      where: { ownerUserId: user.id },
    });

    // Before the fix this read MANAGED: signup omitted the column and Postgres
    // supplied the default, so every account created after the origin
    // migration described its own record as a dependent.
    expect(person.origin).toBe('SELF');
    expect(person.claimedAt).not.toBeNull();
  });

  it('leaves a real dependent MANAGED', async () => {
    const manager = await createUser();
    const dependent = await createManagedPerson(manager.id, 'Grandma Ngozi');

    expect(dependent.origin).toBe('MANAGED');
    expect(dependent.ownerUserId).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Emptiness — the moderate definition
// ────────────────────────────────────────────────────────────────────────

describe('what counts as an empty record', () => {
  it('a record created seconds ago at signup is empty', async () => {
    const user = await signup('fresh@test.local');
    const person = await prisma.person.findFirstOrThrow({ where: { ownerUserId: user.id } });

    const verdict = await personClaimService.assessEmptiness(person.id);
    expect(verdict.isEmpty).toBe(true);
  });

  it('a lazily-created health profile of all nulls is an empty shell', async () => {
    const user = await createUser();

    // Exactly what `personHealthService.update` writes for a PATCH carrying
    // nothing: it upserts, so the row exists and holds nothing at all. Its
    // existence proves an endpoint was called, not that anything was recorded.
    await request(app)
      .patch(`/api/v1/persons/${user.personId}/health`)
      .set(...authHeader(user))
      .send({})
      .expect(200);

    const row = await prisma.personHealthProfile.findUnique({
      where: { personId: user.personId },
    });
    expect(row).not.toBeNull();
    expect(row!.bloodGroup).toBeNull();
    expect(row!.allergies).toEqual([]);

    const verdict = await personClaimService.assessEmptiness(user.personId);
    expect(verdict.isEmpty).toBe(true);
    expect(verdict.signals.healthProfileFields).toBe(0);
  });

  it('one recorded field makes it not empty', async () => {
    const user = await createUser();

    await request(app)
      .patch(`/api/v1/persons/${user.personId}/health`)
      .set(...authHeader(user))
      .send({ bloodGroup: 'O+' })
      .expect(200);

    const verdict = await personClaimService.assessEmptiness(user.personId);
    expect(verdict.isEmpty).toBe(false);
    expect(verdict.signals.healthProfileFields).toBe(1);
  });

  it('demographics from the signup form are not data', async () => {
    const user = await createUser();

    await prisma.person.update({
      where: { id: user.personId },
      data: { gender: 'FEMALE', dateOfBirth: new Date('1994-03-02') },
    });

    const verdict = await personClaimService.assessEmptiness(user.personId);
    expect(verdict.isEmpty).toBe(true);
  });

  it('a record somebody else has access to is in use', async () => {
    const user = await createUser();
    const partner = await createUser();

    await prisma.personMembership.create({
      data: {
        personId: user.personId,
        userId: partner.id,
        role: 'CAREGIVER',
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });

    // No clinical rows at all, and still not empty: archiving it would end the
    // partner's access without anybody deciding to.
    const verdict = await personClaimService.assessEmptiness(user.personId);
    expect(verdict.isEmpty).toBe(false);
    expect(verdict.signals.sharedWithOtherAccounts).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────
// The dominant case: somebody new to Vitals, arriving from an invitation
// ────────────────────────────────────────────────────────────────────────

describe('claiming a record set up about you', () => {
  it('moves ownership, supersedes the empty record and revokes the manager', async () => {
    const ada = await createUser({ email: 'ada@test.local' });
    const emmasRecord = await createManagedPerson(ada.id, 'Emma Okafor');

    // Ada has been recording Emma's care for months.
    await populate(emmasRecord.id, ada.id);

    await personInvitationService.invite(ada.id, emmasRecord.id, {
      email: 'emma@test.local',
      role: 'CAREGIVER',
      claimable: true,
    });

    const token = await tokenFor('emma@test.local');

    // Emma follows the link and creates an account. Signup gives her a
    // self-Person, so the dominant case always goes through the merge path —
    // which is exactly why emptiness has to accept a record this new.
    const emma = await signup('emma@test.local');
    const emmasOwnPerson = await prisma.person.findFirstOrThrow({
      where: { ownerUserId: emma.id },
    });

    const result: any = await personInvitationService.respond(emma.id, token, 'claim');

    expect(result.outcome).toBe('claimed');
    expect(result.supersededPersonId).toBe(emmasOwnPerson.id);
    expect(result.revoked).toEqual([
      expect.objectContaining({ userId: ada.id, role: 'OWNER' }),
    ]);

    const claimed = await prisma.person.findUniqueOrThrow({ where: { id: emmasRecord.id } });
    expect(claimed.ownerUserId).toBe(emma.id);
    expect(claimed.claimedAt).not.toBeNull();
    expect(claimed.archivedAt).toBeNull();

    // The record she arrived with is archived, not deleted, and releases the
    // unique slot so the claimed record can take it.
    const superseded = await prisma.person.findUniqueOrThrow({
      where: { id: emmasOwnPerson.id },
    });
    expect(superseded.ownerUserId).toBeNull();
    expect(superseded.archivedAt).not.toBeNull();

    // One self-Person per account still holds, as an index and not a hope.
    const owned = await prisma.person.count({ where: { ownerUserId: emma.id } });
    expect(owned).toBe(1);

    // Ada is out. Once the record's subject owns it, Ada's access is Emma's
    // decision rather than something inherited from setting the record up.
    const adasMembership = await prisma.personMembership.findUniqueOrThrow({
      where: { personId_userId: { personId: emmasRecord.id, userId: ada.id } },
    });
    expect(adasMembership.status).toBe('REVOKED');
    expect(adasMembership.receivesNotifications).toBe(false);

    await request(app)
      .get(`/api/v1/persons/${emmasRecord.id}`)
      .set(...authHeader(ada))
      .expect(403);
  });

  it('reads the same rows Ada was reading — nothing was copied', async () => {
    const ada = await createUser({ email: 'ada@test.local' });
    const emmasRecord = await createManagedPerson(ada.id, 'Emma Okafor');
    const { carePlanId } = await populate(emmasRecord.id, ada.id);

    await personInvitationService.invite(ada.id, emmasRecord.id, {
      email: 'emma@test.local',
      role: 'CAREGIVER',
      claimable: true,
    });
    const token = await tokenFor('emma@test.local');
    const emma = await signup('emma@test.local');

    await personInvitationService.respond(emma.id, token, 'claim');

    // The same care plan row, still pointing at the same Person. A claim moves
    // a pointer; it never duplicates clinical data.
    const plans = await prisma.carePlan.findMany({ where: { personId: emmasRecord.id } });
    expect(plans).toHaveLength(1);
    expect(plans[0].id).toBe(carePlanId);

    const health = await request(app)
      .get(`/api/v1/persons/${emmasRecord.id}/health`)
      .set('Authorization', `Bearer ${(await signIn(emma.id)).token}`)
      .expect(200);

    expect(health.body.data.bloodGroup).toBe('O+');
    expect(health.body.data.allergies).toEqual(['penicillin']);
  });

  it('writes both the claim and the revocation to the ledger', async () => {
    const ada = await createUser({ email: 'ada@test.local' });
    const emmasRecord = await createManagedPerson(ada.id, 'Emma Okafor');

    await personInvitationService.invite(ada.id, emmasRecord.id, {
      email: 'emma@test.local',
      role: 'CAREGIVER',
      claimable: true,
    });
    const token = await tokenFor('emma@test.local');
    const emma = await signup('emma@test.local');

    await personInvitationService.respond(emma.id, token, 'claim');

    const ledger = await prisma.personAccessEvent.findMany({
      where: { personId: emmasRecord.id },
      orderBy: { occurredAt: 'asc' },
    });

    expect(ledger.map((e) => [e.action, e.basis])).toEqual(
      expect.arrayContaining([
        ['REVOKED', 'claim-revoke'],
        ['CLAIMED', 'self-claim'],
      ]),
    );

    const revoked = ledger.find((e) => e.action === 'REVOKED')!;
    expect(revoked.subjectUserId).toBe(ada.id);
    expect(revoked.actorUserId).toBe(emma.id);
  });

  it('frees the manager’s managed slot and costs the claimant nothing', async () => {
    const ada = await createUser({ email: 'ada@test.local' });
    const emmasRecord = await createManagedPerson(ada.id, 'Emma Okafor');

    expect((await personRepository.capacityFor(ada.id)).managedUsed).toBe(1);

    await personInvitationService.invite(ada.id, emmasRecord.id, {
      email: 'emma@test.local',
      role: 'CAREGIVER',
      claimable: true,
    });
    const token = await tokenFor('emma@test.local');
    const emma = await signup('emma@test.local');

    await personInvitationService.respond(emma.id, token, 'claim');

    // Nothing decrements a counter: Ada's membership is REVOKED, so it stops
    // being counted, and Emma owns the record so it is on neither of her axes.
    const adaAfter = await personRepository.capacityFor(ada.id);
    expect(adaAfter.managedUsed).toBe(0);
    expect(adaAfter.connectionsUsed).toBe(0);

    const emmaAfter = await personRepository.capacityFor(emma.id);
    expect(emmaAfter).toMatchObject({ managedUsed: 0, connectionsUsed: 0 });
  });

  it('refuses to claim a record the inviter did not offer as one', async () => {
    const ada = await createUser({ email: 'ada@test.local' });
    const baby = await createManagedPerson(ada.id, 'Baby Zuri');

    // An ordinary share. Without the inviter's assertion, being shown a record
    // would be enough to take it — and an aunt invited to a baby's vaccination
    // schedule could lock the parent out.
    await personInvitationService.invite(ada.id, baby.id, {
      email: 'aunt@test.local',
      role: 'VIEWER',
    });
    const token = await tokenFor('aunt@test.local');
    const aunt = await signup('aunt@test.local', 'Ifeoma');

    await expect(personInvitationService.respond(aunt.id, token, 'claim')).rejects.toMatchObject(
      { errorCode: 'BAD_REQUEST' },
    );

    const baby2 = await prisma.person.findUniqueOrThrow({ where: { id: baby.id } });
    expect(baby2.ownerUserId).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// The refusal path
// ────────────────────────────────────────────────────────────────────────

describe('a claim by an account that already has a record of its own', () => {
  async function setup() {
    const ada = await createUser({ email: 'ada@test.local' });
    const record = await createManagedPerson(ada.id, 'Emma Okafor');

    await personInvitationService.invite(ada.id, record.id, {
      email: 'emma@test.local',
      role: 'CAREGIVER',
      claimable: true,
    });
    const token = await tokenFor('emma@test.local');

    const emma = await signup('emma@test.local');
    const emmasOwn = await prisma.person.findFirstOrThrow({ where: { ownerUserId: emma.id } });

    return { ada, record, token, emma, emmasOwn };
  }

  it('is refused, and neither record moves', async () => {
    const { ada, record, token, emma, emmasOwn } = await setup();

    // Emma has been using Vitals for her own health for a year.
    await populate(emmasOwn.id, emma.id);

    const result: any = await personInvitationService.respond(emma.id, token, 'claim');

    expect(result.outcome).toBe('refused');
    expect(result.connectionStillAvailable).toBe(true);
    expect(result.blockedBy).toMatchObject({
      carePlans: 1,
      symptomLogs: 1,
      healthProfileFields: 4,
    });

    // Nothing merged, nothing copied, nothing archived.
    const target = await prisma.person.findUniqueOrThrow({ where: { id: record.id } });
    expect(target.ownerUserId).toBeNull();

    const own = await prisma.person.findUniqueOrThrow({ where: { id: emmasOwn.id } });
    expect(own.ownerUserId).toBe(emma.id);
    expect(own.archivedAt).toBeNull();

    // Ada keeps the record she has been managing.
    const adasMembership = await prisma.personMembership.findUniqueOrThrow({
      where: { personId_userId: { personId: record.id, userId: ada.id } },
    });
    expect(adasMembership.status).toBe('ACTIVE');
  });

  it('records the refusal without recording why', async () => {
    const { record, token, emma, emmasOwn } = await setup();
    await populate(emmasOwn.id, emma.id);

    await personInvitationService.respond(emma.id, token, 'claim');

    const refusal = await prisma.personAccessEvent.findFirstOrThrow({
      where: { personId: record.id, action: 'CLAIM_REFUSED' },
    });

    expect(refusal.subjectUserId).toBe(emma.id);
    expect(refusal.basis).toBe('claim-refused');

    // The ledger is readable by everyone with read access to this record, Ada
    // included. That someone tried is her record's history; what is in Emma's
    // own health record is not hers to see.
    expect(refusal.metadata).toEqual({});
  });

  it('leaves the invitation open, and connecting still works', async () => {
    const { ada, record, token, emma, emmasOwn } = await setup();
    await populate(emmasOwn.id, emma.id);

    await personInvitationService.respond(emma.id, token, 'claim');

    // The invitation was always a connection invitation; claiming was an
    // upgrade offered on top of it. Not taking the upgrade leaves the offer.
    const stillPending = await prisma.personInvitation.findFirstOrThrow({
      where: { personId: record.id },
    });
    expect(stillPending.status).toBe('PENDING');

    // Free tier connects to nobody, so give Emma the room to accept.
    await prisma.user.update({ where: { id: emma.id }, data: { connectionLimit: 1 } });

    const connected: any = await personInvitationService.respond(emma.id, token, 'connect');
    expect(connected.outcome).toBe('connected');
    expect(connected.membership.status).toBe('ACTIVE');

    const settled = await prisma.personInvitation.findFirstOrThrow({
      where: { personId: record.id },
    });
    expect(settled.status).toBe('ACCEPTED');

    // Ada's view is unchanged throughout: she invited someone, they accepted,
    // they are connected. She never learns a claim was attempted or why it
    // could not proceed.
    const members = await request(app)
      .get(`/api/v1/persons/${record.id}/members`)
      .set(...authHeader(ada))
      .expect(200);

    const emmaRow = members.body.data.find((m: any) => m.userId === emma.id);
    expect(emmaRow.status).toBe('ACTIVE');
    expect(emmaRow.role).toBe('CAREGIVER');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Re-granting, and unlinking
// ────────────────────────────────────────────────────────────────────────

describe('keeping the caregiver, or not', () => {
  async function claimed() {
    const ada = await createUser({ email: 'ada@test.local' });
    const record = await createManagedPerson(ada.id, 'Emma Okafor');
    await populate(record.id, ada.id);

    await personInvitationService.invite(ada.id, record.id, {
      email: 'emma@test.local',
      role: 'CAREGIVER',
      claimable: true,
    });
    const token = await tokenFor('emma@test.local');
    const emma = await signup('emma@test.local');
    await personInvitationService.respond(emma.id, token, 'claim');

    return { ada, record, emma };
  }

  it('restores the manager in one step, as a second ledger event', async () => {
    const { ada, record, emma } = await claimed();

    // Ada is on the free tier: connectionLimit 0. A claim must not quietly
    // cost the caregiver their access, so this continuation bypasses the
    // ceiling exactly as a handoff does.
    expect((await personRepository.capacityFor(ada.id)).connectionLimit).toBe(0);

    await request(app)
      .post(`/api/v1/persons/${record.id}/claim-regrant`)
      .set('Authorization', `Bearer ${(await signIn(emma.id)).token}`)
      .send({ grants: [{ userId: ada.id, role: 'CAREGIVER' }] })
      .expect(200);

    const membership = await prisma.personMembership.findUniqueOrThrow({
      where: { personId_userId: { personId: record.id, userId: ada.id } },
    });
    expect(membership.status).toBe('ACTIVE');
    expect(membership.role).toBe('CAREGIVER');

    // Two events, because two decisions were made.
    const events = await prisma.personAccessEvent.findMany({
      where: { personId: record.id, subjectUserId: ada.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['REVOKED', 'GRANTED']),
    );
    expect(events[events.length - 1].basis).toBe('claim-regrant');

    // Ada can read the record again, and the same rows are there.
    await request(app)
      .get(`/api/v1/persons/${record.id}/health`)
      .set(...authHeader(ada))
      .expect(200);
  });

  it('cannot be used to grant access to anybody else', async () => {
    const { record, emma } = await claimed();
    const stranger = await createUser();

    await request(app)
      .post(`/api/v1/persons/${record.id}/claim-regrant`)
      .set('Authorization', `Bearer ${(await signIn(emma.id)).token}`)
      .send({ grants: [{ userId: stranger.id, role: 'CAREGIVER' }] })
      .expect(400);

    const membership = await prisma.personMembership.findUnique({
      where: { personId_userId: { personId: record.id, userId: stranger.id } },
    });
    expect(membership).toBeNull();
  });

  it('unlinking removes access and nothing else', async () => {
    const { ada, record, emma } = await claimed();
    const emmaToken = (await signIn(emma.id)).token;

    await request(app)
      .post(`/api/v1/persons/${record.id}/claim-regrant`)
      .set('Authorization', `Bearer ${emmaToken}`)
      .send({ grants: [{ userId: ada.id, role: 'CAREGIVER' }] })
      .expect(200);

    const before = await prisma.carePlan.count({ where: { personId: record.id } });

    await request(app)
      .delete(`/api/v1/persons/${record.id}/members/${ada.id}`)
      .set('Authorization', `Bearer ${emmaToken}`)
      .expect(200);

    await request(app)
      .get(`/api/v1/persons/${record.id}/health`)
      .set(...authHeader(ada))
      .expect(403);

    // Removing a relationship removes access only. It never deletes an
    // account and never deletes health data.
    expect(await prisma.carePlan.count({ where: { personId: record.id } })).toBe(before);
    expect(await prisma.user.count({ where: { id: ada.id } })).toBe(1);
    expect(
      (await prisma.personHealthProfile.findUnique({ where: { personId: record.id } }))
        ?.bloodGroup,
    ).toBe('O+');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Invitations addressed to somebody who has no account
// ────────────────────────────────────────────────────────────────────────

describe('an invitation outlives the absence of an account', () => {
  it('is created for an address with nobody behind it', async () => {
    const ada = await createUser({ email: 'ada@test.local' });
    const record = await createManagedPerson(ada.id, 'Emma Okafor');

    const { invitation, membership } = await personInvitationService.invite(
      ada.id,
      record.id,
      { email: 'Emma@Test.Local', role: 'CAREGIVER', claimable: true },
    );

    // Lower-cased at write time: addresses are matched, so they cannot be
    // matched loosely.
    expect(invitation.email).toBe('emma@test.local');
    expect(invitation.status).toBe('PENDING');
    // No account, so no relationship yet. The offer is the only record.
    expect(membership).toBeNull();
  });

  it('the old members route still answers 404 for an unknown address', async () => {
    const ada = await createUser({ email: 'ada@test.local' });
    const record = await createManagedPerson(ada.id, 'Emma Okafor');

    // Unchanged contract. Clients on the pre-session-7 surface see no
    // difference at all.
    await request(app)
      .post(`/api/v1/persons/${record.id}/members`)
      .set(...authHeader(ada))
      .send({ email: 'nobody@test.local', role: 'VIEWER' })
      .expect(404);
  });

  it('shows the link’s contents without anyone signing in', async () => {
    const ada = await createUser({ email: 'ada@test.local' });
    const record = await createManagedPerson(ada.id, 'Emma Okafor');

    await personInvitationService.invite(ada.id, record.id, {
      email: 'emma@test.local',
      role: 'CAREGIVER',
      claimable: true,
    });
    const token = await tokenFor('emma@test.local');

    const res = await request(app).get(`/api/v1/invitations/${token}`).expect(200);

    expect(res.body.data).toMatchObject({
      recordName: 'Emma Okafor',
      role: 'CAREGIVER',
      claimable: true,
      requiresSignup: true,
    });
  });

  it('refuses a token that does not match the account answering it', async () => {
    const ada = await createUser({ email: 'ada@test.local' });
    const record = await createManagedPerson(ada.id, 'Emma Okafor');

    await personInvitationService.invite(ada.id, record.id, {
      email: 'emma@test.local',
      role: 'CAREGIVER',
      claimable: true,
    });
    const token = await tokenFor('emma@test.local');

    const someoneElse = await signup('mallory@test.local', 'Mallory');

    await expect(
      personInvitationService.respond(someoneElse.id, token, 'claim'),
    ).rejects.toMatchObject({ errorCode: 'NOT_FOUND' });

    const untouched = await prisma.person.findUniqueOrThrow({ where: { id: record.id } });
    expect(untouched.ownerUserId).toBeNull();
  });

  it('refuses an unverified address', async () => {
    const ada = await createUser({ email: 'ada@test.local' });
    const record = await createManagedPerson(ada.id, 'Emma Okafor');

    await personInvitationService.invite(ada.id, record.id, {
      email: 'emma@test.local',
      role: 'CAREGIVER',
      claimable: true,
    });
    const token = await tokenFor('emma@test.local');

    const emma = await signup('emma@test.local');
    await prisma.user.update({ where: { id: emma.id }, data: { emailVerified: false } });

    await expect(personInvitationService.respond(emma.id, token, 'claim')).rejects.toMatchObject(
      { errorCode: 'FORBIDDEN' },
    );
  });

  it('surfaces pending invitations to the account that signed up from one', async () => {
    const ada = await createUser({ email: 'ada@test.local' });
    const record = await createManagedPerson(ada.id, 'Emma Okafor');

    await personInvitationService.invite(ada.id, record.id, {
      email: 'emma@test.local',
      role: 'CAREGIVER',
      claimable: true,
    });

    const emma = await signup('emma@test.local');

    const pending = await personInvitationService.listPending(emma.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ personId: record.id, claimable: true });
  });

  it('declining withdraws the offer and leaves no relationship', async () => {
    const ada = await createUser({ email: 'ada@test.local' });
    const record = await createManagedPerson(ada.id, 'Emma Okafor');

    await personInvitationService.invite(ada.id, record.id, {
      email: 'emma@test.local',
      role: 'CAREGIVER',
    });
    const token = await tokenFor('emma@test.local');
    const emma = await signup('emma@test.local');

    const result: any = await personInvitationService.respond(emma.id, token, 'decline');
    expect(result.outcome).toBe('declined');

    const invitation = await prisma.personInvitation.findFirstOrThrow({
      where: { personId: record.id },
    });
    expect(invitation.status).toBe('DECLINED');

    const membership = await prisma.personMembership.findUnique({
      where: { personId_userId: { personId: record.id, userId: emma.id } },
    });
    expect(membership).toBeNull();
  });
});

/**
 * A token for an account the factory did not create. `authService.signup`
 * returns one, but tests that sign up and then act as that account several
 * times over need a fresh one without re-running signup.
 */
async function signIn(userId: string): Promise<{ token: string }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  return {
    token: jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        planType: user.planType,
        emailVerified: user.emailVerified,
      },
      process.env.JWT_ACCESS_SECRET as string,
      { expiresIn: '15m' },
    ),
  };
}

describe('answering from inside Vitals, without the emailed link', () => {
  /**
   * The id route exists for the account that was created *from* an invitation:
   * by the time they are looking at their own list of offers, the email has
   * usually been used or lost. What it must not become is a second, weaker way
   * in — so every test here is about the id proving nothing on its own.
   */

  it('accepts an offer listed for this account', async () => {
    const ada = await createUser({ email: 'ada@test.local' });
    const emma = await createUser({ email: 'emma@test.local' });
    const record = await createManagedPerson(ada.id, 'Emma Okafor');

    await personInvitationService.invite(ada.id, record.id, {
      email: 'emma@test.local',
      role: 'CAREGIVER',
    });

    // Exactly what the in-app list shows, and the only place the id comes from.
    const listed = await personInvitationService.listPending(emma.id);
    expect(listed).toHaveLength(1);

    // Free tier connects to nobody. Capacity is checked on the *accepting*
    // account, so Emma needs the room whichever route she answers through.
    await prisma.user.update({ where: { id: emma.id }, data: { connectionLimit: 1 } });

    const res = await request(app)
      .post(`/api/v1/invitations/by-id/${listed[0].invitationId}/respond`)
      .set(...authHeader(emma))
      .send({ mode: 'connect' })
      .expect(200);

    expect(res.body.data.outcome).toBe('connected');

    const membership = await prisma.personMembership.findUniqueOrThrow({
      where: { personId_userId: { personId: record.id, userId: emma.id } },
    });
    expect(membership.status).toBe('ACTIVE');
    expect(membership.role).toBe('CAREGIVER');

    // And the offer is settled, so it stops appearing and cannot be answered
    // twice.
    expect(await personInvitationService.listPending(emma.id)).toHaveLength(0);
  });

  it('declines one, leaving no relationship behind', async () => {
    const ada = await createUser({ email: 'ada@test.local' });
    const emma = await createUser({ email: 'emma@test.local' });
    const record = await createManagedPerson(ada.id, 'Emma Okafor');

    await personInvitationService.invite(ada.id, record.id, {
      email: 'emma@test.local',
      role: 'VIEWER',
    });

    const [listed] = await personInvitationService.listPending(emma.id);

    const res = await request(app)
      .post(`/api/v1/invitations/by-id/${listed.invitationId}/respond`)
      .set(...authHeader(emma))
      .send({ mode: 'decline' })
      .expect(200);

    expect(res.body.data.outcome).toBe('declined');

    const invitation = await prisma.personInvitation.findUniqueOrThrow({
      where: { id: listed.invitationId },
    });
    expect(invitation.status).toBe('DECLINED');

    // The INVITED membership created alongside the offer goes with it. It
    // never granted anything, so nothing was taken away.
    const membership = await prisma.personMembership.findUnique({
      where: { personId_userId: { personId: record.id, userId: emma.id } },
    });
    expect(membership).toBeNull();
  });

  /**
   * The case the id route exists to be safe about.
   *
   * Ids are not secrets — they are handed out by `listPending` and will end up
   * in logs, in a browser history, in a screenshot. Holding one must be worth
   * nothing at all to an account the offer was not addressed to.
   */
  it('refuses an id addressed to somebody else, and says nothing about it', async () => {
    const ada = await createUser({ email: 'ada@test.local' });
    const emma = await createUser({ email: 'emma@test.local' });
    const mallory = await createUser({ email: 'mallory@test.local' });
    const record = await createManagedPerson(ada.id, 'Emma Okafor');

    const { invitation } = await personInvitationService.invite(ada.id, record.id, {
      email: 'emma@test.local',
      role: 'CAREGIVER',
      claimable: true,
    });

    for (const mode of ['connect', 'claim', 'decline'] as const) {
      const res = await request(app)
        .post(`/api/v1/invitations/by-id/${invitation.id}/respond`)
        .set(...authHeader(mallory))
        .send({ mode })
        .expect(404);

      // The same answer a non-existent id gets. Nothing distinguishes "this
      // offer is not yours" from "there is no such offer", so the route cannot
      // be used to discover which addresses have live invitations.
      expect(res.body.message).toBe('No pending invitation for this account');
    }

    // Nothing moved: the offer is still Emma's to answer.
    const after = await prisma.personInvitation.findUniqueOrThrow({
      where: { id: invitation.id },
    });
    expect(after.status).toBe('PENDING');

    expect(
      await prisma.personMembership.findUnique({
        where: { personId_userId: { personId: record.id, userId: mallory.id } },
      }),
    ).toBeNull();

    // And Emma can still answer it afterwards.
    const [listed] = await personInvitationService.listPending(emma.id);
    expect(listed.invitationId).toBe(invitation.id);
  });

  it('answers an id that does not exist the same way', async () => {
    const emma = await createUser({ email: 'emma@test.local' });

    const res = await request(app)
      .post('/api/v1/invitations/by-id/3f1b0c9e-0000-4000-8000-000000000000/respond')
      .set(...authHeader(emma))
      .send({ mode: 'connect' })
      .expect(404);

    expect(res.body.message).toBe('No pending invitation for this account');
  });

  it('refuses an unverified address, as the token route does', async () => {
    const ada = await createUser({ email: 'ada@test.local' });
    const emma = await createUser({ email: 'emma@test.local' });
    const record = await createManagedPerson(ada.id, 'Emma Okafor');

    const { invitation } = await personInvitationService.invite(ada.id, record.id, {
      email: 'emma@test.local',
      role: 'CAREGIVER',
    });

    await prisma.user.update({
      where: { id: emma.id },
      data: { emailVerified: false },
    });

    await request(app)
      .post(`/api/v1/invitations/by-id/${invitation.id}/respond`)
      .set(...authHeader(emma))
      .send({ mode: 'connect' })
      .expect(403);
  });

  it('takes ownership through the id route, revoking the manager exactly as the link does', async () => {
    const ada = await createUser({ email: 'ada@test.local' });
    const emma = await createUser({ email: 'emma@test.local' });
    const record = await createManagedPerson(ada.id, 'Emma Okafor');

    await personInvitationService.invite(ada.id, record.id, {
      email: 'emma@test.local',
      role: 'CAREGIVER',
      claimable: true,
    });

    const [listed] = await personInvitationService.listPending(emma.id);
    expect(listed.claimable).toBe(true);

    const res = await request(app)
      .post(`/api/v1/invitations/by-id/${listed.invitationId}/respond`)
      .set(...authHeader(emma))
      .send({ mode: 'claim' })
      .expect(200);

    expect(res.body.data.outcome).toBe('claimed');
    expect(res.body.data.revoked).toHaveLength(1);
    expect(res.body.data.revoked[0].userId).toBe(ada.id);

    const claimed = await prisma.person.findUniqueOrThrow({ where: { id: record.id } });
    expect(claimed.ownerUserId).toBe(emma.id);

    // Emma's own empty record was superseded, so the unique index still holds.
    const owned = await prisma.person.count({
      where: { ownerUserId: emma.id, archivedAt: null },
    });
    expect(owned).toBe(1);
  });

  it('refuses a settled offer, so an id cannot be replayed', async () => {
    const ada = await createUser({ email: 'ada@test.local' });
    const emma = await createUser({ email: 'emma@test.local' });
    const record = await createManagedPerson(ada.id, 'Emma Okafor');

    await personInvitationService.invite(ada.id, record.id, {
      email: 'emma@test.local',
      role: 'VIEWER',
    });

    const [listed] = await personInvitationService.listPending(emma.id);
    await prisma.user.update({ where: { id: emma.id }, data: { connectionLimit: 1 } });

    await request(app)
      .post(`/api/v1/invitations/by-id/${listed.invitationId}/respond`)
      .set(...authHeader(emma))
      .send({ mode: 'connect' })
      .expect(200);

    await request(app)
      .post(`/api/v1/invitations/by-id/${listed.invitationId}/respond`)
      .set(...authHeader(emma))
      .send({ mode: 'connect' })
      .expect(404);
  });

  it('the preview names the record, so a screen can link to it afterwards', async () => {
    const ada = await createUser({ email: 'ada@test.local' });
    const record = await createManagedPerson(ada.id, 'Emma Okafor');

    await personInvitationService.invite(ada.id, record.id, {
      email: 'emma@test.local',
      role: 'CAREGIVER',
    });

    const token = await tokenFor('emma@test.local');

    const res = await request(app).get(`/api/v1/invitations/${token}`).expect(200);

    expect(res.body.data.personId).toBe(record.id);
    expect(res.body.data.recordName).toBe('Emma Okafor');
  });
});
