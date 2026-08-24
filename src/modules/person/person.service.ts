import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { personRepository } from './person.repository';

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
