import crypto from 'node:crypto';

import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { outboxRepository } from '@/modules/outbox/outbox.repository';
import { personAccess } from './person.access';
import { personClaimService } from './person.claim.service';
import { personRepository } from './person.repository';

const log = createLogger('person-invitation-service');

const INVITATION_TTL_DAYS = 14;

const hashToken = (raw: string): string =>
  crypto.createHash('sha256').update(raw).digest('hex');

/** One casing, everywhere. Addresses are matched, so they cannot be matched loosely. */
const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/**
 * Invitations: the offer of access, and what happens when it is answered.
 *
 * The offer is addressed to an *email*, not to an account, because the case
 * that dominates is somebody who has never used Vitals arriving from a link
 * their sister sent them. PersonMembership cannot express that — its `userId`
 * is a required foreign key — so the offer gets a record of its own and the
 * membership is created when there is an account to attach it to.
 *
 * Answering an invitation has three shapes, and the invitee picks:
 *
 *   connect — take the access that was offered. The ordinary case.
 *   claim   — "this record is about me". Offered only when the inviter marked
 *             it so and the invitee's own record is empty; otherwise the
 *             invitation carries on as an ordinary connection.
 *   decline — no.
 */
/** Everything answering an offer needs, and nothing else. */
const INVITATION_FOR_ANSWER = {
  id: true,
  status: true,
  expiresAt: true,
  claimable: true,
  role: true,
  person: { select: { id: true } },
} as const;

type AnswerableInvitation = {
  id: string;
  status: string;
  expiresAt: Date;
  claimable: boolean;
  role: 'OWNER' | 'CAREGIVER' | 'VIEWER';
  person: { id: string };
};

/**
 * The gate every answer passes through, whichever handle was used to find the
 * offer — a token from an email, or an id from the caller's own list.
 *
 * Written once on purpose. This is the check that decides who may read
 * somebody's health record and who a record is about, and a second copy of it
 * is a second thing to get wrong. Both routes hand in a finder; the finder is
 * given the caller's verified address and must narrow by it, so "not addressed
 * to you" and "does not exist" are one outcome rather than two.
 */
const answerInvitation = async (
  userId: string,
  mode: 'connect' | 'claim' | 'decline',
  find: (verifiedEmail: string) => Promise<AnswerableInvitation | null>,
) => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });

  // Checked before the lookup, so an unverified account cannot use this to
  // discover whether an address it has not proven owns any live invitations.
  if (!user.emailVerified) {
    throw AppError.forbidden(
      'Verify your email address before responding to this invitation',
    );
  }

  const invitation = await find(normalizeEmail(user.email));

  // One error for "no such invitation", "not yours" and "already answered".
  // Distinguishing them would let a caller probe which addresses have live
  // invitations against which records.
  const unusable =
    !invitation ||
    invitation.status !== 'PENDING' ||
    invitation.expiresAt.getTime() < Date.now();

  if (!invitation || unusable) {
    throw AppError.notFound('No pending invitation for this account');
  }

  const personId = invitation.person.id;

  if (mode === 'decline') {
    return personInvitationService.decline(userId, invitation.id, personId);
  }

  if (mode === 'claim') {
    return personInvitationService.attemptClaim(
      userId,
      invitation.id,
      personId,
      invitation.claimable,
    );
  }

  return personInvitationService.connect(
    userId,
    invitation.id,
    personId,
    invitation.role,
  );
};

export const personInvitationService = {
  /**
   * Offer access to a record.
   *
   * `manage` is required, so only an OWNER can widen access — a caregiver
   * cannot do it on somebody else's behalf.
   *
   * `requireExistingAccount` preserves the pre-session-7 contract of
   * `POST /persons/:id/members`, which answered 404 for an address with no
   * account behind it. That route still does. The invitation route does not,
   * which is the point of it.
   */
  async invite(
    userId: string,
    personId: string,
    input: {
      email: string;
      role: 'CAREGIVER' | 'VIEWER';
      claimable?: boolean;
      requireExistingAccount?: boolean;
    },
  ) {
    await personAccess.assertPersonAccess(userId, personId, 'manage');

    const email = normalizeEmail(input.email);
    const claimable = input.claimable ?? false;

    const person = await prisma.person.findUniqueOrThrow({
      where: { id: personId },
      select: { id: true, displayName: true, ownerUserId: true },
    });

    // A record that already belongs to somebody cannot be offered to anybody
    // else as theirs to take. Ownership moves by handoff after that, and that
    // is a different path with different rules.
    if (claimable && person.ownerUserId) {
      throw AppError.conflict(
        'This record already belongs to the person it is about',
      );
    }

    const invitee = await prisma.user.findFirst({
      where: { email, isActive: true, erasedAt: null },
      select: { id: true, email: true },
    });

    if (!invitee && input.requireExistingAccount) {
      throw AppError.notFound('No active Vitals account with that email address');
    }

    if (invitee?.id === userId) {
      throw AppError.badRequest('You already have access to this record');
    }

    if (invitee) {
      const existing = await prisma.personMembership.findUnique({
        where: { personId_userId: { personId, userId: invitee.id } },
      });

      if (existing && existing.status === 'ACTIVE') {
        throw AppError.conflict('That account already has access to this record');
      }
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

    const result = await prisma.$transaction(async (tx) => {
      // Supersede any live offer to the same address for the same record. The
      // partial unique index permits exactly one, so re-inviting replaces
      // rather than accumulates — and the superseded row stays as history.
      await tx.personInvitation.updateMany({
        where: { personId, email, status: 'PENDING' },
        data: { status: 'REVOKED', respondedAt: new Date() },
      });

      const invitation = await tx.personInvitation.create({
        data: {
          personId,
          email,
          role: input.role,
          claimable,
          tokenHash: hashToken(rawToken),
          expiresAt,
          invitedByUserId: userId,
        },
      });

      // When there is an account, the membership is created INVITED exactly as
      // it was before invitations existed — so `listMembers`, `accept` and
      // everything else that reads memberships see no change at all.
      let membership = null;
      if (invitee) {
        membership = await tx.personMembership.upsert({
          where: { personId_userId: { personId, userId: invitee.id } },
          create: {
            personId,
            userId: invitee.id,
            role: input.role,
            status: 'INVITED',
            receivesNotifications: false,
          },
          // A previously revoked grant is re-issued as a fresh invitation
          // rather than silently reactivated — the revocation stays in the
          // ledger.
          update: {
            role: input.role,
            status: 'INVITED',
            invitedAt: new Date(),
            acceptedAt: null,
            revokedAt: null,
          },
        });

        await personRepository.recordAccessEvent(
          {
            personId,
            subjectUserId: invitee.id,
            actorUserId: userId,
            action: 'GRANTED',
            role: input.role,
            basis: 'owner-invite',
          },
          tx,
        );
      }

      const inviter = await tx.user.findUnique({
        where: { id: userId },
        select: { firstName: true, lastName: true, email: true },
      });

      // Delivery goes through the outbox, in the same transaction as the row
      // it announces: an invitation that exists but was never sent, or an
      // email for an invitation that was rolled back, are both worse than a
      // slow send.
      await outboxRepository.create(
        {
          ...(invitee ? { userId: invitee.id } : {}),
          type: 'PERSON_INVITATION',
          payload: {
            email,
            rawToken,
            personDisplayName: person.displayName,
            inviterName:
              [inviter?.firstName, inviter?.lastName].filter(Boolean).join(' ') ||
              inviter?.email ||
              'Someone',
            hasAccount: Boolean(invitee),
            acceptUrl: `${env.FRONTEND_URL}/invitations/${rawToken}`,
          },
        },
        tx,
      );

      return { invitation, membership };
    });

    log.info('Access invited', {
      personId,
      email,
      role: input.role,
      claimable,
      hasAccount: Boolean(invitee),
    });

    return result;
  },

  /**
   * What the link shows before anyone signs in.
   *
   * The token went to the address, so holding it is the authorisation. What it
   * reveals is kept to what the email already said: who invited you and what
   * the record is called.
   */
  async preview(rawToken: string) {
    const invitation = await prisma.personInvitation.findUnique({
      where: { tokenHash: hashToken(rawToken) },
      select: {
        email: true,
        role: true,
        claimable: true,
        status: true,
        expiresAt: true,
        person: { select: { id: true, displayName: true, ownerUserId: true } },
        invitedBy: { select: { firstName: true, lastName: true } },
      },
    });

    if (!invitation) throw AppError.notFound('This invitation link is not valid');

    const expired = invitation.expiresAt.getTime() < Date.now();

    return {
      /**
       * Which record this is about.
       *
       * Not a disclosure: the id names a record the reader was just told the
       * display name of, and it grants nothing on its own — every person-scoped
       * endpoint resolves access before answering. It is here so that a screen
       * which has just accepted an invitation can send the reader to the record
       * they accepted, rather than to a profile page and a hunt.
       */
      personId: invitation.person.id,
      email: invitation.email,
      role: invitation.role,
      // Withdrawn once the record has been claimed by somebody, so the screen
      // never offers an upgrade that acceptance would then refuse.
      claimable: invitation.claimable && invitation.person.ownerUserId === null,
      recordName: invitation.person.displayName,
      inviterName:
        [invitation.invitedBy?.firstName, invitation.invitedBy?.lastName]
          .filter(Boolean)
          .join(' ') || 'Someone',
      status: expired && invitation.status === 'PENDING' ? 'EXPIRED' : invitation.status,
      expiresAt: invitation.expiresAt,
      /** Whether signing in is enough, or an account has to be created first. */
      requiresSignup: !(await prisma.user.findFirst({
        where: { email: invitation.email, isActive: true, erasedAt: null },
        select: { id: true },
      })),
    };
  },

  /** Live invitations addressed to the caller. Shown after signing up from a link. */
  async listPending(userId: string) {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, emailVerified: true },
    });

    if (!user.emailVerified) return [];

    const invitations = await prisma.personInvitation.findMany({
      where: {
        email: normalizeEmail(user.email),
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        role: true,
        claimable: true,
        expiresAt: true,
        person: { select: { id: true, displayName: true, ownerUserId: true } },
        invitedBy: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return invitations.map((i) => ({
      invitationId: i.id,
      personId: i.person.id,
      recordName: i.person.displayName,
      role: i.role,
      claimable: i.claimable && i.person.ownerUserId === null,
      inviterName:
        [i.invitedBy?.firstName, i.invitedBy?.lastName].filter(Boolean).join(' ') ||
        'Someone',
      expiresAt: i.expiresAt,
    }));
  },

  /**
   * Answer an invitation.
   *
   * The address on the invitation has to match the *verified* address of the
   * account answering it. An unverified address is an unproven claim to an
   * identity, and this is the one place where the identity is the whole point:
   * accepting decides who gets to read somebody's health record, and claiming
   * decides who that record is about.
   */
  async respond(
    userId: string,
    rawToken: string,
    mode: 'connect' | 'claim' | 'decline',
  ) {
    return answerInvitation(userId, mode, (email) =>
      prisma.personInvitation.findFirst({
        where: {
          tokenHash: hashToken(rawToken),
          // Narrowed here rather than checked afterwards so that both lookups
          // are the same query with a different handle on the front of it.
          email,
        },
        select: INVITATION_FOR_ANSWER,
      }),
    );
  },

  /**
   * Answer an invitation by its id, for a caller who is already signed in.
   *
   * The same offer, reached differently. The token route serves somebody
   * arriving from an email; this serves somebody who is already inside Vitals
   * and can see the offer listed — the case of an account created *from* an
   * invitation, where the email has usually been closed and the link lost.
   *
   * The id is not a credential and is not treated as one. It appears in
   * `listPending`, which only ever returns offers addressed to the caller's own
   * verified address, so possession of an id proves nothing. Authorisation is
   * the address match, exactly as on the token route: the lookup is narrowed by
   * the caller's verified email, so an id belonging to somebody else's offer
   * finds nothing and answers the same 404 as an id that does not exist.
   */
  async respondById(
    userId: string,
    invitationId: string,
    mode: 'connect' | 'claim' | 'decline',
  ) {
    return answerInvitation(userId, mode, (email) =>
      prisma.personInvitation.findFirst({
        where: { id: invitationId, email },
        select: INVITATION_FOR_ANSWER,
      }),
    );
  },

  /**
   * Take the access that was offered. The ordinary path, and the one a refused
   * claim falls back to.
   *
   * Capacity is checked here because this is where the membership becomes
   * ACTIVE — a ceiling on new, never a continuous check.
   */
  async connect(
    userId: string,
    invitationId: string,
    personId: string,
    role: 'OWNER' | 'CAREGIVER' | 'VIEWER',
  ) {
    const capacity = await personRepository.capacityFor(userId);
    if (capacity.connectionsUsed >= capacity.connectionLimit) {
      throw AppError.badRequest(
        'You have reached the number of people this account can connect to. ' +
          'Upgrade to accept this invitation.',
      );
    }

    return prisma.$transaction(async (tx) => {
      const membership = await tx.personMembership.upsert({
        where: { personId_userId: { personId, userId } },
        create: {
          personId,
          userId,
          role,
          status: 'ACTIVE',
          receivesNotifications: false,
          acceptedAt: new Date(),
        },
        update: { role, status: 'ACTIVE', acceptedAt: new Date(), revokedAt: null },
      });

      await tx.personInvitation.update({
        where: { id: invitationId },
        data: { status: 'ACCEPTED', acceptedAt: new Date(), respondedAt: new Date() },
      });

      await personRepository.recordAccessEvent(
        {
          personId,
          subjectUserId: userId,
          actorUserId: userId,
          action: 'ACCEPTED',
          role,
          basis: 'invite-accept',
        },
        tx,
      );

      log.info('Invitation accepted as connection', { personId, userId, role });
      return { outcome: 'connected' as const, membership };
    });
  },

  /**
   * "This record is about me."
   *
   * Two conditions, and they fail differently. The inviter has to have marked
   * the record claimable, which is a fact about the invitation and is refused
   * outright. And the invitee's own record has to be empty, which is a fact
   * about them — so that one is not an error at all. The invitation was always
   * a connection invitation; claiming is an upgrade offered on top of it. Not
   * being able to take the upgrade leaves an ordinary invitation, still open,
   * still acceptable.
   */
  async attemptClaim(
    userId: string,
    invitationId: string,
    personId: string,
    claimable: boolean,
  ) {
    if (!claimable) {
      throw AppError.badRequest('This invitation does not offer ownership of the record');
    }

    const person = await prisma.person.findUniqueOrThrow({
      where: { id: personId },
      select: { ownerUserId: true },
    });

    if (person.ownerUserId) {
      throw AppError.conflict('This record already belongs to someone');
    }

    const selfPerson = await prisma.person.findFirst({
      where: { ownerUserId: userId, archivedAt: null },
      select: { id: true },
    });

    const verdict = selfPerson
      ? await personClaimService.assessEmptiness(selfPerson.id)
      : { isEmpty: true, signals: {} };

    if (!verdict.isEmpty) {
      await personClaimService.recordRefusal({ userId, personId, basis: 'claim-refused' });

      log.info('Claim refused, connection still offered', { personId, userId });

      // The invitation stays PENDING and the membership, if there is one,
      // stays INVITED. Nothing has been decided yet — the invitee is being
      // shown the other door, and may also walk away.
      return {
        outcome: 'refused' as const,
        // The invitee's own signals, returned to the invitee. This never
        // reaches the inviter: it is not written to the ledger, and the ledger
        // is the only part of this the inviter can read.
        blockedBy: Object.fromEntries(
          Object.entries(verdict.signals).filter(([, n]) => n > 0),
        ),
        connectionStillAvailable: true,
      };
    }

    const result = await prisma.$transaction(async (tx) => {
      const claimed = await personClaimService.claim({
        userId,
        personId,
        supersededPersonId: selfPerson?.id ?? null,
        basis: 'self-claim',
        tx,
      });

      await tx.personInvitation.update({
        where: { id: invitationId },
        data: { status: 'ACCEPTED', acceptedAt: new Date(), respondedAt: new Date() },
      });

      return claimed;
    });

    return {
      outcome: 'claimed' as const,
      personId,
      supersededPersonId: selfPerson?.id ?? null,
      /**
       * Everyone the claim just removed. The screen after this one asks the
       * claimant whether to keep them — one tap for the common case where the
       * caregiver should stay — and posts the answer to the re-grant route.
       */
      revoked: result.revoked,
    };
  },

  /** No. Recorded on the invitation; the ledger stays for access, not offers. */
  async decline(userId: string, invitationId: string, personId: string) {
    return prisma.$transaction(async (tx) => {
      await tx.personInvitation.update({
        where: { id: invitationId },
        data: { status: 'DECLINED', respondedAt: new Date() },
      });

      // An INVITED membership created alongside the offer goes with it. It
      // never granted anything, so nothing is being taken away and there is
      // nothing to record in a ledger of access.
      await tx.personMembership.deleteMany({
        where: { personId, userId, status: 'INVITED' },
      });

      log.info('Invitation declined', { personId, userId });
      return { outcome: 'declined' as const };
    });
  },

  /** Withdraw an offer that has not been answered. Requires `manage`. */
  async revokeInvitation(userId: string, personId: string, invitationId: string) {
    await personAccess.assertPersonAccess(userId, personId, 'manage');

    const invitation = await prisma.personInvitation.findFirst({
      where: { id: invitationId, personId, status: 'PENDING' },
      select: { id: true, email: true },
    });

    if (!invitation) throw AppError.notFound('No pending invitation to withdraw');

    return prisma.$transaction(async (tx) => {
      await tx.personInvitation.update({
        where: { id: invitation.id },
        data: { status: 'REVOKED', respondedAt: new Date() },
      });

      const invitee = await tx.user.findFirst({
        where: { email: invitation.email },
        select: { id: true },
      });

      if (invitee) {
        await tx.personMembership.deleteMany({
          where: { personId, userId: invitee.id, status: 'INVITED' },
        });
      }

      log.info('Invitation withdrawn', { personId, invitationId, actorUserId: userId });
      return { outcome: 'withdrawn' as const };
    });
  },

  /** Live and settled offers on a record. Readable by anyone with read access. */
  async listForPerson(userId: string, personId: string) {
    await personAccess.assertPersonAccess(userId, personId, 'read');

    return prisma.personInvitation.findMany({
      where: { personId },
      select: {
        id: true,
        email: true,
        role: true,
        claimable: true,
        status: true,
        expiresAt: true,
        acceptedAt: true,
        respondedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  },
};
