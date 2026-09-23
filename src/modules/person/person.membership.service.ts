import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { personAccess } from './person.access';
import { personRepository } from './person.repository';
import { personService } from './person.service';
import { personInvitationService } from './person.invitation.service';

const log = createLogger('person-membership-service');

/**
 * The membership surface: who may see whose health data, and how that is
 * granted, accepted and revoked.
 *
 * Consent is a state, not a checkbox. A grant starts INVITED and only becomes
 * ACTIVE when the other account accepts, and every transition is appended to
 * the ledger — a revocation is a new row, never a mutation of the grant it
 * revokes.
 */
export const personMembershipService = {
  /** Every Person the caller can read. The person switcher's data source. */
  async listForAccount(userId: string) {
    const memberships = await prisma.personMembership.findMany({
      where: { userId, status: 'ACTIVE', person: { archivedAt: null } },
      select: {
        role: true,
        person: {
          select: {
            id: true,
            displayName: true,
            dateOfBirth: true,
            gender: true,
            origin: true,
            ownerUserId: true,
            claimedAt: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((m) => ({
      personId: m.person.id,
      displayName: m.person.displayName,
      dateOfBirth: m.person.dateOfBirth,
      gender: m.person.gender,
      origin: m.person.origin,
      role: m.role,
      isSelf: m.person.ownerUserId === userId,
      // Unclaimed: this Person has no account of their own. A managed record.
      isClaimed: m.person.claimedAt !== null,
    }));
  },

  async get(userId: string, personId: string) {
    await personAccess.assertPersonAccess(userId, personId, 'read');

    const person = await prisma.person.findUniqueOrThrow({
      where: { id: personId },
      select: {
        id: true,
        displayName: true,
        dateOfBirth: true,
        gender: true,
        origin: true,
        ownerUserId: true,
        claimedAt: true,
        archivedAt: true,
      },
    });

    return { ...person, isSelf: person.ownerUserId === userId };
  },

  /**
   * Demographics — name, date of birth, gender.
   *
   * These describe a body, so they live on the Person alongside the clinical
   * attributes rather than on the account's Profile. Profile keeps its copies
   * during the compatibility window, unread.
   *
   * Requires `write`: a caregiver correcting a dependent's date of birth is
   * ordinary care, but a VIEWER must not.
   */
  async updateDemographics(
    userId: string,
    personId: string,
    input: { displayName?: string; dateOfBirth?: string | null; gender?: string | null },
  ) {
    await personAccess.assertPersonAccess(userId, personId, 'write');

    const data: Record<string, unknown> = {};
    if (input.displayName !== undefined) data.displayName = input.displayName;
    if (input.gender !== undefined) data.gender = input.gender;
    if (input.dateOfBirth !== undefined) {
      data.dateOfBirth = input.dateOfBirth ? new Date(input.dateOfBirth) : null;
    }

    const person = await prisma.person.update({
      where: { id: personId },
      data,
      select: {
        id: true,
        displayName: true,
        dateOfBirth: true,
        gender: true,
        origin: true,
      },
    });

    log.info('Person demographics updated', { personId, actorUserId: userId });
    return person;
  },

  /**
   * Create a dependent — someone whose health this account will manage and who
   * has no Vitals account of their own.
   *
   * Entitlement is checked here and only here: a ceiling on new, never a
   * continuous check. Babies come through the mother-baby journey instead,
   * which carries its own first-baby exemption.
   */
  async createManagedPerson(
    userId: string,
    input: { displayName: string; dateOfBirth?: string; gender?: string },
  ) {
    await personService.assertCanAddManagedPerson(userId);

    return prisma.$transaction(async (tx) => {
      const person = await tx.person.create({
        data: {
          displayName: input.displayName,
          dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null,
          ...(input.gender ? { gender: input.gender as any } : {}),
          createdByUserId: userId,
          origin: 'MANAGED',
        },
      });

      await tx.personMembership.create({
        data: {
          personId: person.id,
          userId,
          role: 'OWNER',
          status: 'ACTIVE',
          receivesNotifications: true,
          acceptedAt: new Date(),
        },
      });

      await personRepository.recordAccessEvent(
        {
          personId: person.id,
          subjectUserId: userId,
          actorUserId: userId,
          action: 'GRANTED',
          role: 'OWNER',
          basis: 'owner-create',
        },
        tx,
      );

      log.info('Managed person created', { personId: person.id, userId });
      return person;
    });
  },

  async listMembers(userId: string, personId: string) {
    await personAccess.assertPersonAccess(userId, personId, 'read');

    return prisma.personMembership.findMany({
      where: { personId },
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        invitedAt: true,
        acceptedAt: true,
        revokedAt: true,
        user: { select: { email: true, firstName: true, lastName: true } },
      },
      orderBy: { invitedAt: 'asc' },
    });
  },

  /**
   * Invite another account to a Person's record.
   *
   * Kept for compatibility and now a thin wrapper: the implementation moved to
   * `personInvitationService.invite`, which can also address an email with no
   * account behind it. `requireExistingAccount` holds this route to its old
   * contract — a 404 for an unknown address — and the return value is still
   * the membership, so no existing client sees a change.
   *
   * Transitional. `POST /persons/:id/invitations` is the surface that carries
   * the token, the expiry and the claimable flag; this one exists so the
   * cutover does not have to be simultaneous.
   */
  async invite(
    userId: string,
    personId: string,
    input: { email: string; role: 'CAREGIVER' | 'VIEWER' },
  ) {
    const { membership } = await personInvitationService.invite(userId, personId, {
      ...input,
      claimable: false,
      requireExistingAccount: true,
    });

    return membership;
  },

  /**
   * Accept an invitation.
   *
   * Only the invited account can accept — consent is given by the person
   * receiving access, not assigned to them. Connecting consumes a connection
   * slot, checked here because this is where the membership becomes ACTIVE.
   */
  async accept(userId: string, personId: string) {
    const membership = await prisma.personMembership.findUnique({
      where: { personId_userId: { personId, userId } },
    });

    if (!membership || membership.status !== 'INVITED') {
      throw AppError.notFound('No pending invitation for this record');
    }

    const capacity = await personRepository.capacityFor(userId);
    if (capacity.connectionsUsed >= capacity.connectionLimit) {
      throw AppError.badRequest(
        'You have reached the number of people this account can connect to. ' +
          'Upgrade to accept this invitation.',
      );
    }

    return prisma.$transaction(async (tx) => {
      const accepted = await tx.personMembership.update({
        where: { id: membership.id },
        data: { status: 'ACTIVE', acceptedAt: new Date() },
      });

      // Settle the offer this membership came from, if it came from one. The
      // membership is the relationship and the invitation is the offer; an
      // answered offer that stays PENDING would keep appearing in the
      // invitee's list and would block a later re-invitation on the partial
      // unique index.
      const invitee = await tx.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });

      if (invitee) {
        await tx.personInvitation.updateMany({
          where: { personId, email: invitee.email.trim().toLowerCase(), status: 'PENDING' },
          data: { status: 'ACCEPTED', acceptedAt: new Date(), respondedAt: new Date() },
        });
      }

      await personRepository.recordAccessEvent(
        {
          personId,
          subjectUserId: userId,
          actorUserId: userId,
          action: 'ACCEPTED',
          role: membership.role,
          basis: 'invite-accept',
        },
        tx,
      );

      log.info('Access accepted', { personId, userId });
      return accepted;
    });
  },

  /**
   * Revoke access. Removing a relationship removes access only — it never
   * deletes an account and never deletes health data.
   *
   * A member may always end their own membership, whatever their role. Someone
   * who shared their record with you can revoke you, and you must equally be
   * able to walk away; requiring `manage` to leave would mean a caregiver
   * needed the owner's permission to stop holding their health data.
   *
   * Revoking *someone else* still requires `manage`, so only an owner can do
   * that. The last owner cannot be revoked by either route — handoff is the
   * path, or the record would be stranded with nobody able to act on it.
   */
  async revoke(userId: string, personId: string, targetUserId: string) {
    const isSelfRevoke = targetUserId === userId;

    if (!isSelfRevoke) {
      await personAccess.assertPersonAccess(userId, personId, 'manage');
    }

    const membership = await prisma.personMembership.findUnique({
      where: { personId_userId: { personId, userId: targetUserId } },
    });

    if (!membership || membership.status === 'REVOKED') {
      throw AppError.notFound('That account does not have access to this record');
    }

    if (membership.role === 'OWNER') {
      // Removing the last owner would strand the record. Handoff is the path.
      const otherOwners = await prisma.personMembership.count({
        where: {
          personId,
          role: 'OWNER',
          status: 'ACTIVE',
          NOT: { userId: targetUserId },
        },
      });

      if (otherOwners === 0) {
        throw AppError.conflict(
          'This is the only owner of the record. Transfer ownership before revoking.',
        );
      }
    }

    return prisma.$transaction(async (tx) => {
      const revoked = await tx.personMembership.update({
        where: { id: membership.id },
        data: { status: 'REVOKED', revokedAt: new Date(), receivesNotifications: false },
      });

      await personRepository.recordAccessEvent(
        {
          personId,
          subjectUserId: targetUserId,
          actorUserId: userId,
          // Who ended the relationship is part of the record, not an
          // implementation detail.
          action: isSelfRevoke ? 'LEFT' : 'REVOKED',
          role: membership.role,
          basis: isSelfRevoke ? 'self-revoke' : 'owner-revoke',
        },
        tx,
      );

      log.info(isSelfRevoke ? 'Member left record' : 'Access revoked', {
        personId,
        targetUserId,
        actorUserId: userId,
      });
      return revoked;
    });
  },

  /** The consent ledger for a record. Readable by anyone with read access. */
  async accessHistory(userId: string, personId: string) {
    await personAccess.assertPersonAccess(userId, personId, 'read');

    return prisma.personAccessEvent.findMany({
      where: { personId },
      orderBy: { occurredAt: 'desc' },
    });
  },
};
