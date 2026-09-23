import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { personRepository } from './person.repository';
import type { PrismaTx } from '@/types/prisma';

const log = createLogger('person-service');

export const personService = {
  /**
   * An account that is the sole owner of somebody else's unclaimed health
   * record cannot simply leave. A baby's vaccination reminders stopping
   * because a parent deactivated their account is the worst failure this
   * design can produce, so it is refused at the door.
   *
   * Resolutions, all explicit: hand the Person over to another account, let
   * the Person claim their own record, or archive it deliberately.
   */
  async assertCanArchiveAccount(userId: string): Promise<void> {
    const blockers = await personRepository.soleOwnedUnclaimedPersons(userId);
    if (blockers.length === 0) return;

    const names = blockers.map((b) => b.displayName).join(', ');
    throw AppError.conflict(
      `This account is the only one managing ${blockers.length} health ` +
        `record(s) (${names}). Transfer them to another account, let the ` +
        `person claim their own record, or archive them before continuing.`,
    );
  },

  /**
   * Entitlement, enforced at creation and only at creation.
   *
   * An account that falls below its limit after a downgrade keeps every Person
   * it already has — health data must never become read-only on a billing
   * event. This is a ceiling on *new*, nothing more.
   */
  async assertCanAddManagedPerson(userId: string): Promise<void> {
    const capacity = await personRepository.capacityFor(userId);

    if (capacity.managedUsed >= capacity.managedLimit) {
      throw AppError.badRequest(
        'You have reached the number of people this account can manage. ' +
          'Upgrade to add another.',
      );
    }
  },

  /**
   * Create a baby as a Person, with the account that recorded the birth as its
   * OWNER.
   *
   * A baby is a Person even with no Vitals account of its own — that is the
   * case the whole separation exists for. Post-birth records describing the
   * baby's health, vaccination plans included, belong to this Person; the
   * mother's pregnancy records stay on hers.
   *
   * The first baby is free. The mother-baby journey is core functionality and
   * the free tier is managedPersonLimit = 0, so gating it on entitlement would
   * gate the product. Later babies consume capacity like any other dependent.
   */
  async createBabyPerson(
    input: {
      userId: string;
      displayName: string;
      dateOfBirth?: Date | null;
      gender?: string | null;
      origin: 'DELIVERY' | 'BABY_PROFILE';
    },
    tx: PrismaTx,
  ) {
    const person = await tx.person.create({
      data: {
        displayName: input.displayName,
        dateOfBirth: input.dateOfBirth ?? null,
        ...(input.gender ? { gender: input.gender as any } : {}),
        // No ownerUserId: the baby has not claimed its own record, and may
        // never do so. That is what makes it a *managed* Person.
        createdByUserId: input.userId,
        origin: input.origin,
      },
    });

    await tx.personMembership.create({
      data: {
        personId: person.id,
        userId: input.userId,
        role: 'OWNER',
        status: 'ACTIVE',
        receivesNotifications: true,
        acceptedAt: new Date(),
      },
    });

    await tx.personAccessEvent.create({
      data: {
        personId: person.id,
        subjectUserId: input.userId,
        actorUserId: input.userId,
        action: 'GRANTED',
        role: 'OWNER',
        basis: input.origin === 'DELIVERY' ? 'delivery' : 'baby-profile',
      },
    });

    log.info('Baby Person created', {
      personId: person.id,
      userId: input.userId,
      origin: input.origin,
    });

    return person;
  },

  /**
   * Hand a managed Person to another account.
   *
   * A transfer deliberately bypasses the recipient's managed-Person ceiling.
   * Receiving a handoff is not a new acquisition, and enforcing the limit here
   * would deadlock the one path that exists to resolve a blocked erasure —
   * leaving destruction of a dependent's records as the only remaining exit,
   * which is exactly what the block exists to prevent.
   */
  async transferOwnership(input: {
    personId: string;
    fromUserId: string;
    toUserId: string;
    actorUserId: string;
  }) {
    const { personId, fromUserId, toUserId, actorUserId } = input;

    if (fromUserId === toUserId) {
      throw AppError.badRequest('Cannot transfer a record to its current owner');
    }

    const person = await prisma.person.findUnique({ where: { id: personId } });
    if (!person) throw AppError.notFound('Person not found');

    if (person.ownerUserId) {
      throw AppError.badRequest(
        'This person has claimed their own record; ownership cannot be transferred',
      );
    }

    const recipient = await prisma.user.findFirst({
      where: { id: toUserId, isActive: true, erasedAt: null },
      select: { id: true },
    });
    if (!recipient) {
      throw AppError.badRequest('The receiving account is not active');
    }

    return prisma.$transaction(async (tx) => {
      const outgoing = await tx.personMembership.findUnique({
        where: { personId_userId: { personId, userId: fromUserId } },
      });

      if (!outgoing || outgoing.role !== 'OWNER' || outgoing.status !== 'ACTIVE') {
        throw AppError.forbidden('Only an active owner can transfer a record');
      }

      await tx.personMembership.update({
        where: { id: outgoing.id },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });

      await tx.personMembership.upsert({
        where: { personId_userId: { personId, userId: toUserId } },
        create: {
          personId,
          userId: toUserId,
          role: 'OWNER',
          status: 'ACTIVE',
          receivesNotifications: true,
          acceptedAt: new Date(),
        },
        update: {
          role: 'OWNER',
          status: 'ACTIVE',
          receivesNotifications: true,
          acceptedAt: new Date(),
          revokedAt: null,
        },
      });

      await personRepository.recordAccessEvent(
        {
          personId,
          subjectUserId: toUserId,
          actorUserId,
          action: 'TRANSFERRED',
          role: 'OWNER',
          basis: 'handoff',
          metadata: { fromUserId, ceilingBypassed: true },
        },
        tx,
      );

      log.info('Person ownership transferred', { personId, fromUserId, toUserId });
      return { personId, toUserId };
    });
  },

  /**
   * Erasure is a state machine, not an operation.
   *
   * The account holder is the data subject for their own records and a
   * *custodian* of a dependent's, so their erasure right does not reach a
   * managed Person's data. When one is stranded the request parks in BLOCKED
   * and waits for an explicit resolution rather than destroying records that
   * belong to someone else.
   */
  async requestErasure(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, erasedAt: true },
    });
    if (!user) throw AppError.notFound('User not found');
    if (user.erasedAt) throw AppError.conflict('This account has already been erased');

    const blockers = await personRepository.soleOwnedUnclaimedPersons(userId);

    const status = blockers.length > 0 ? 'BLOCKED' : 'READY';
    const reason =
      blockers.length > 0
        ? `Sole manager of ${blockers.length} unclaimed health record(s): ` +
          blockers.map((b) => b.displayName).join(', ')
        : null;

    await prisma.user.update({
      where: { id: userId },
      data: { erasureStatus: status, erasureBlockedReason: reason },
    });

    log.info('Erasure requested', { userId, status, blockers: blockers.length });
    return { status, blockers };
  },
};
