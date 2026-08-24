import { prisma } from '@/lib/prisma';
import { personService } from '@/modules/person/person.service';
import { personRepository } from '@/modules/person/person.repository';
import { erasureService } from '@/modules/person/erasure.service';
import { recipientResolver } from '@/modules/care/recipient.resolver';
import { userService } from '@/modules/user/user.service';
import { createUser } from './helpers/factories';

/**
 * Phase C behaviour, against real rows. These paths are all about which rows a
 * query returns and which constraints reject a write, so a mocked client would
 * prove nothing.
 */

/** A dependent: a Person nobody has claimed, managed by one account. */
async function createManagedPerson(managerUserId: string, name = 'Baby') {
  const person = await prisma.person.create({
    data: { displayName: name, createdByUserId: managerUserId },
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

describe('capacity is derived, never stored', () => {
  it('a self-Person consumes neither axis', async () => {
    const user = await createUser();

    const capacity = await personRepository.capacityFor(user.id);
    expect(capacity).toMatchObject({
      managedLimit: 0,
      managedUsed: 0,
      connectionLimit: 0,
      connectionsUsed: 0,
    });
  });

  it('a managed Person consumes a managed slot, and claiming frees it', async () => {
    const manager = await createUser();
    const dependent = await createManagedPerson(manager.id);

    expect((await personRepository.capacityFor(manager.id)).managedUsed).toBe(1);

    // The dependent claims their own record. Nothing decrements a counter —
    // ownerUserId simply stops being NULL.
    //
    // The claimer here is an account with no self-Person of its own. An
    // account that already has one cannot also own this record: the unique
    // index permits one Person per account, and CLAUDE.md forbids solving
    // that by duplicating. See the report — the merge case is unresolved.
    const claimer = await prisma.user.create({
      data: { email: `claimer-${Date.now()}@test.local`, passwordHash: 'x' },
    });
    await prisma.person.update({
      where: { id: dependent.id },
      data: { ownerUserId: claimer.id, claimedAt: new Date() },
    });

    const after = await personRepository.capacityFor(manager.id);
    expect(after.managedUsed).toBe(0);
    expect(after.connectionsUsed).toBe(1);
  });
});

describe('archiving an account cannot strand a dependent', () => {
  it('blocks deactivation while sole owner of an unclaimed Person', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const manager = await createUser();
    await createManagedPerson(manager.id, 'Baby Ada');

    await expect(userService.deactivateUser(admin.id, manager.id)).rejects.toMatchObject({
      errorCode: 'CONFLICT',
    });

    const still = await prisma.user.findUnique({ where: { id: manager.id } });
    expect(still?.isActive).toBe(true);
  });

  it('allows it once the record has been handed over', async () => {
    const admin = await createUser({ role: 'ADMIN' });
    const manager = await createUser();
    const receiver = await createUser();

    const dependent = await createManagedPerson(manager.id, 'Baby Ada');

    // The receiver's ceiling is 0 — a handoff is not a new acquisition and
    // must not be refused, or a blocked erasure would have no exit.
    expect((await personRepository.capacityFor(receiver.id)).managedLimit).toBe(0);

    await personService.transferOwnership({
      personId: dependent.id,
      fromUserId: manager.id,
      toUserId: receiver.id,
      actorUserId: manager.id,
    });

    expect((await personRepository.capacityFor(receiver.id)).managedUsed).toBe(1);

    await expect(userService.deactivateUser(admin.id, manager.id)).resolves.toBeUndefined();
  });

  it('records the handoff in the consent ledger', async () => {
    const manager = await createUser();
    const receiver = await createUser();
    const dependent = await createManagedPerson(manager.id);

    await personService.transferOwnership({
      personId: dependent.id,
      fromUserId: manager.id,
      toUserId: receiver.id,
      actorUserId: manager.id,
    });

    const events = await prisma.personAccessEvent.findMany({
      where: { personId: dependent.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'TRANSFERRED', basis: 'handoff' });

    // Revocation is recorded, not erased: the outgoing membership is still
    // there, marked REVOKED, alongside the ledger entry.
    const outgoing = await prisma.personMembership.findFirst({
      where: { personId: dependent.id, userId: manager.id },
    });
    expect(outgoing?.status).toBe('REVOKED');
    expect(outgoing?.revokedAt).not.toBeNull();
  });
});

describe('erasure requests park rather than destroy', () => {
  it('is BLOCKED while a dependent is stranded, READY once it is not', async () => {
    const manager = await createUser();
    const dependent = await createManagedPerson(manager.id, 'Baby Ada');

    const blocked = await personService.requestErasure(manager.id);
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.blockers).toHaveLength(1);

    await prisma.person.update({
      where: { id: dependent.id },
      data: { archivedAt: new Date() },
    });

    const ready = await personService.requestErasure(manager.id);
    expect(ready.status).toBe('READY');
  });

  it('refuses to execute while blocked', async () => {
    const manager = await createUser();
    await createManagedPerson(manager.id);

    await expect(erasureService.execute(manager.id, manager.id)).rejects.toMatchObject({
      errorCode: 'CONFLICT',
    });
  });
});

describe('erasure destroys the subject’s data and tombstones the row', () => {
  it('keeps the users row so Restrict is never defeated', async () => {
    const user = await createUser({ email: 'erase-me@test.local' });
    const personId = user.personId;

    await prisma.carePlan.create({
      data: { userId: user.id, personId, type: 'MEDICATION', title: 'X' },
    });
    await prisma.symptomLog.create({
      data: { userId: user.id, personId, symptomsText: 'headache' },
    });
    await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: 'hash-1', expiresAt: new Date(Date.now() + 86400000) },
    });

    const result = await erasureService.execute(user.id, user.id);
    expect(result.clinicalRowsDestroyed).toBeGreaterThan(0);

    const tombstone = await prisma.user.findUnique({ where: { id: user.id } });
    expect(tombstone).not.toBeNull();
    expect(tombstone?.erasedAt).not.toBeNull();
    expect(tombstone?.isActive).toBe(false);
    expect(tombstone?.passwordHash).toBe('');
    expect(tombstone?.email).not.toBe('erase-me@test.local');
    expect(tombstone?.email).toContain('@invalid');

    expect(await prisma.carePlan.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.symptomLog.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);

    // The Person is tombstoned, not deleted — the append-only consent ledger
    // references it. Identity is gone; the anchor remains.
    const erasedPerson = await prisma.person.findUnique({ where: { id: personId } });
    expect(erasedPerson).not.toBeNull();
    expect(erasedPerson?.displayName).toBe('Erased');
    expect(erasedPerson?.ownerUserId).toBeNull();
    expect(erasedPerson?.archivedAt).not.toBeNull();
    expect(await prisma.personHealthProfile.count({ where: { personId } })).toBe(0);

    // The ledger entry survives and still says what happened.
    const ledger = await prisma.personAccessEvent.findMany({ where: { personId } });
    expect(ledger.some((e) => e.action === 'ERASED')).toBe(true);

    // The address is freed, because the unique value changed.
    await expect(
      prisma.user.create({
        data: { email: 'erase-me@test.local', passwordHash: 'x' },
      }),
    ).resolves.toBeTruthy();
  });

  it('nulls attribution on another Person’s surviving records', async () => {
    const carer = await createUser();
    const other = await createUser();


    // The carer acted on someone else's history.
    const log = await prisma.activityLog.create({
      data: {
        userId: other.id,
        personId: other.personId,
        actorUserId: carer.id,
        type: 'MEDICATION_CREATED',
        message: 'Created on their behalf',
      },
    });

    await erasureService.execute(carer.id, carer.id);

    const survived = await prisma.activityLog.findUnique({ where: { id: log.id } });
    expect(survived).not.toBeNull();
    expect(survived?.actorUserId).toBeNull();
    expect(survived?.personId).toBe(other.personId);
  });
});

describe('reminder recipients resolve at delivery time', () => {
  it('skips a deactivated account', async () => {
    const user = await createUser();
    const plan = await prisma.carePlan.create({
      data: { userId: user.id, personId: user.personId, type: 'MEDICATION', title: 'X' },
    });

    expect(await recipientResolver.forCarePlan(plan)).toHaveLength(1);

    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

    // Nothing consulted isActive before phase C — this used to return a
    // recipient that could not act on the reminder.
    expect(await recipientResolver.forCarePlan(plan)).toHaveLength(0);
  });

  it('skips a membership that no longer receives notifications', async () => {
    const user = await createUser();
    const plan = await prisma.carePlan.create({
      data: { userId: user.id, personId: user.personId, type: 'MEDICATION', title: 'X' },
    });

    await prisma.personMembership.updateMany({
      where: { personId: user.personId },
      data: { receivesNotifications: false },
    });

    expect(await recipientResolver.forCarePlan(plan)).toHaveLength(0);
  });

  it('falls back to the account for a plan with no subject yet', async () => {
    const user = await createUser();
    const plan = await prisma.carePlan.create({
      data: { userId: user.id, type: 'MEDICATION', title: 'Not yet backfilled' },
    });

    const recipients = await recipientResolver.forCarePlan(plan);
    expect(recipients).toHaveLength(1);
    expect(recipients[0].id).toBe(user.id);
  });
});
