import { prisma } from '@/lib/prisma';
import { recipientResolver } from '@/modules/care/recipient.resolver';
import { personService } from '@/modules/person/person.service';
import { createUser } from './helpers/factories';

/**
 * Recipients are resolved at delivery, not carried from enqueue.
 *
 * Every case below is a change that happens *between* the two. A payload that
 * named a recipient when the job was created would be wrong in all of them,
 * and re-targeting on claim would only fix the first.
 */

async function makeManagedPerson(ownerId: string, name = 'Baby') {
  const person = await prisma.person.create({
    data: { displayName: name, createdByUserId: ownerId, origin: 'DELIVERY' },
  });
  await prisma.personMembership.create({
    data: {
      personId: person.id,
      userId: ownerId,
      role: 'OWNER',
      status: 'ACTIVE',
      receivesNotifications: true,
      acceptedAt: new Date(),
    },
  });
  return person;
}

describe('forPerson resolves current state, not enqueue-time state', () => {
  it('returns the account that receives notifications for the person', async () => {
    const owner = await createUser();
    const baby = await makeManagedPerson(owner.id);

    const recipients = await recipientResolver.forPerson(baby.id);
    expect(recipients).toHaveLength(1);
    expect(recipients[0].id).toBe(owner.id);
    expect(recipients[0].email).toBe(owner.email);
  });

  it('follows a handoff that happened after the job was enqueued', async () => {
    const parent = await createUser();
    const guardian = await createUser();
    const baby = await makeManagedPerson(parent.id);

    // Enqueue-time answer.
    expect((await recipientResolver.forPerson(baby.id))[0].id).toBe(parent.id);

    await personService.transferOwnership({
      personId: baby.id,
      fromUserId: parent.id,
      toUserId: guardian.id,
      actorUserId: parent.id,
    });

    // Delivery-time answer. A payload naming the parent would now email the
    // wrong person about a baby they no longer care for.
    const after = await recipientResolver.forPerson(baby.id);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(guardian.id);
  });

  it('drops a revoked membership', async () => {
    const owner = await createUser();
    const carer = await createUser();
    const baby = await makeManagedPerson(owner.id);

    const membership = await prisma.personMembership.create({
      data: {
        personId: baby.id,
        userId: carer.id,
        role: 'CAREGIVER',
        status: 'ACTIVE',
        receivesNotifications: true,
        acceptedAt: new Date(),
      },
    });
    expect(await recipientResolver.forPerson(baby.id)).toHaveLength(2);

    await prisma.personMembership.update({
      where: { id: membership.id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });

    const after = await recipientResolver.forPerson(baby.id);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(owner.id);
  });

  it('drops a deactivated account', async () => {
    const owner = await createUser();
    const baby = await makeManagedPerson(owner.id);

    await prisma.user.update({ where: { id: owner.id }, data: { isActive: false } });

    expect(await recipientResolver.forPerson(baby.id)).toHaveLength(0);
  });

  it('drops an erased account', async () => {
    const owner = await createUser();
    const baby = await makeManagedPerson(owner.id);

    await prisma.user.update({
      where: { id: owner.id },
      data: { erasedAt: new Date(), email: 'erased-x@invalid' },
    });

    expect(await recipientResolver.forPerson(baby.id)).toHaveLength(0);
  });
});

describe('the legacy shape still drains, with the same liveness checks', () => {
  it('falls back to userId when a job carries no personId', async () => {
    const user = await createUser();

    const recipients = await recipientResolver.forPerson(undefined, user.id);
    expect(recipients).toHaveLength(1);
    expect(recipients[0].id).toBe(user.id);
  });

  it('refuses a legacy job addressed to a deactivated account', async () => {
    const user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

    // An old job must not deliver to an account that has since been archived.
    expect(await recipientResolver.forPerson(undefined, user.id)).toHaveLength(0);
  });

  it('prefers the subject when a job carries both', async () => {
    const parent = await createUser();
    const guardian = await createUser();
    const baby = await makeManagedPerson(parent.id);

    await personService.transferOwnership({
      personId: baby.id,
      fromUserId: parent.id,
      toUserId: guardian.id,
      actorUserId: parent.id,
    });

    // A transitional job carrying both: personId wins, so the stale userId
    // cannot resurrect the previous recipient.
    const recipients = await recipientResolver.forPerson(baby.id, parent.id);
    expect(recipients).toHaveLength(1);
    expect(recipients[0].id).toBe(guardian.id);
  });

  it('returns nobody rather than guessing when a job carries neither', async () => {
    expect(await recipientResolver.forPerson(undefined, undefined)).toHaveLength(0);
  });
});

describe('idempotency keys name the recipient', () => {
  it('lets a handoff deliver once to each recipient, not once in total', async () => {
    const parent = await createUser();
    const guardian = await createUser();
    const baby = await makeManagedPerson(parent.id);

    const plan = await prisma.carePlan.create({
      data: { userId: parent.id, personId: baby.id, type: 'MEDICATION', title: 'X' },
    });
    const event = await prisma.careEvent.create({
      data: {
        carePlanId: plan.id,
        eventType: 'MEDICATION_DOSE',
        title: 'Dose',
        scheduledFor: new Date(),
      },
    });
    const reminder = await prisma.reminder.create({
      data: { careEventId: event.id, channel: 'EMAIL', sendAt: new Date() },
    });

    // Two sends for one reminder, to two different people. A key of
    // `fallback:<reminderId>` alone would swallow the second as a duplicate.
    await prisma.notificationAttempt.create({
      data: {
        reminderId: reminder.id,
        channel: 'EMAIL',
        type: 'FALLBACK_EMAIL',
        status: 'SENT',
        idempotencyKey: `fallback:${reminder.id}:${parent.id}`,
      },
    });

    await expect(
      prisma.notificationAttempt.create({
        data: {
          reminderId: reminder.id,
          channel: 'EMAIL',
          type: 'FALLBACK_EMAIL',
          status: 'SENT',
          idempotencyKey: `fallback:${reminder.id}:${guardian.id}`,
        },
      }),
    ).resolves.toBeTruthy();

    // ...while a repeat to the same recipient is still refused.
    await expect(
      prisma.notificationAttempt.create({
        data: {
          reminderId: reminder.id,
          channel: 'EMAIL',
          type: 'FALLBACK_EMAIL',
          status: 'SENT',
          idempotencyKey: `fallback:${reminder.id}:${parent.id}`,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    expect(
      await prisma.notificationAttempt.count({ where: { reminderId: reminder.id } }),
    ).toBe(2);
  });
});
