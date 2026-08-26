import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { personRepository } from './person.repository';
import type { PrismaTx } from '@/types/prisma';

const log = createLogger('person-claim-service');

/**
 * Claiming: an account taking ownership of a record somebody else set up
 * about them.
 *
 * The whole problem lives in one line of the schema — `@@unique([ownerUserId])`
 * on Person. An account owns at most one Person, which is what makes
 * "self-Person" mean something and what lets managed-versus-connected be
 * derived rather than counted. A claim by an account that already has a
 * self-Person would need two, and the invariant stays: an existing active user
 * being invited to claim a record about them is the rare case, and the
 * dominant one — somebody new to Vitals arriving from an invitation — never
 * needs it.
 *
 * So the conflict is resolved at acceptance, in one of two ways:
 *
 *   - the claimant's own record is empty, so nothing is lost by superseding
 *     it. Their self-Person is archived, ownership moves, and the claimed
 *     record becomes theirs.
 *   - it is not empty, and the claim is refused. Nothing is merged, nothing is
 *     copied, and the refusal is written to the ledger.
 *
 * Note what is *not* here: any path that copies clinical rows from one Person
 * to another. Two accounts reading one Person read the same rows; a claim
 * moves a pointer, never data.
 */

/**
 * What counts as an empty record.
 *
 * The signup case has to pass. Somebody who followed an invitation link,
 * created an account thirty seconds ago and has touched nothing must be able
 * to claim, or the dominant flow refuses itself. So the demographics signup
 * writes — display name, and the gender and date of birth taken on the signup
 * form — are not data. They describe the account holder, they are re-derivable
 * from the account, and the record being claimed carries its own.
 *
 * A PersonHealthProfile row is not data either when its contents are all null.
 * `personHealthService.update` upserts, so a PATCH carrying nothing at all
 * creates a row of nulls; its existence proves only that an endpoint was
 * called. Emptiness is read from the contents, never from the row.
 *
 * Everything else counts. One recorded symptom, one appointment, one blood
 * group — anything the person actually put into Vitals about their body — and
 * the record is theirs and stays theirs.
 */
export interface EmptinessVerdict {
  isEmpty: boolean;
  /** Which signals were found. Never shown to the inviter. */
  signals: Record<string, number>;
}

const HEALTH_SCALARS = [
  'bloodGroup',
  'genotype',
  'heightCm',
  'weightKg',
  'smokingStatus',
  'alcoholUse',
] as const;

const HEALTH_LISTS = [
  'allergies',
  'existingConditions',
  'currentMedications',
  'disabilities',
] as const;

export const personClaimService = {
  /**
   * Is this Person an empty shell?
   *
   * Every count is taken in one round trip and all of them are reported, not
   * just the first hit — the caller has to be able to tell somebody what is in
   * the way, and "you have data" is not an answer anyone can act on.
   */
  async assessEmptiness(personId: string): Promise<EmptinessVerdict> {
    const person = await prisma.person.findUnique({
      where: { id: personId },
      select: { ownerUserId: true },
    });
    if (!person) throw AppError.notFound('Person not found');

    const [
      carePlans,
      appointments,
      symptomLogs,
      moodLogs,
      drugDetections,
      medicationDrafts,
      reportGenerations,
      healthProfile,
      otherMembers,
    ] = await Promise.all([
      prisma.carePlan.count({ where: { personId } }),
      prisma.appointment.count({ where: { personId } }),
      prisma.symptomLog.count({ where: { personId } }),
      prisma.moodLog.count({ where: { personId } }),
      prisma.drugDetection.count({ where: { personId } }),
      prisma.medicationDraft.count({ where: { personId } }),
      prisma.reportGeneration.count({ where: { personId } }),
      prisma.personHealthProfile.findUnique({ where: { personId } }),
      // Somebody else holding access is a signal in its own right. Archiving
      // this record would end their access silently, and a record being shared
      // is about as clear a statement as there is that it is in use — even if
      // it happens to hold no clinical rows yet.
      prisma.personMembership.count({
        where: {
          personId,
          status: 'ACTIVE',
          ...(person.ownerUserId ? { NOT: { userId: person.ownerUserId } } : {}),
        },
      }),
    ]);

    // Contents, not existence. A lazily-created row of nulls is an empty shell.
    let healthFields = 0;
    if (healthProfile) {
      for (const key of HEALTH_SCALARS) {
        if (healthProfile[key] !== null && healthProfile[key] !== undefined) healthFields += 1;
      }
      for (const key of HEALTH_LISTS) {
        if ((healthProfile[key] ?? []).length > 0) healthFields += 1;
      }
    }

    const signals: Record<string, number> = {
      carePlans,
      appointments,
      symptomLogs,
      moodLogs,
      drugDetections,
      medicationDrafts,
      reportGenerations,
      healthProfileFields: healthFields,
      sharedWithOtherAccounts: otherMembers,
    };

    const isEmpty = Object.values(signals).every((n) => n === 0);
    return { isEmpty, signals };
  },

  /**
   * Take ownership of `personId` as `userId`.
   *
   * Ordering inside the transaction is not incidental. `@@unique([ownerUserId])`
   * is a real index, so the outgoing self-Person has to release the column
   * before the incoming record can take it — release, then acquire, in that
   * order, or the second write is rejected.
   *
   * Everyone who was managing the record loses access at the moment of the
   * claim. Once the record's subject owns it, anyone else's access is the
   * subject's decision rather than something inherited from having set the
   * record up first. Restoring it is a separate, explicit step — see
   * `regrantAfterClaim` — so that the ledger carries two events, because two
   * decisions were made.
   */
  async claim(input: {
    userId: string;
    personId: string;
    /** The caller's current self-Person, already checked for emptiness. */
    supersededPersonId: string | null;
    basis: string;
    tx: PrismaTx;
  }) {
    const { userId, personId, supersededPersonId, basis, tx } = input;

    // Release first. Nulling ownerUserId is what frees the unique slot; the
    // row itself is archived, never deleted, and its clinical data — of which
    // there is none, or we would not be here — is untouched either way.
    if (supersededPersonId) {
      await tx.person.update({
        where: { id: supersededPersonId },
        data: { ownerUserId: null, claimedAt: null, archivedAt: new Date() },
      });

      await personRepository.recordAccessEvent(
        {
          personId: supersededPersonId,
          subjectUserId: userId,
          actorUserId: userId,
          action: 'ARCHIVED',
          basis: 'claim-superseded',
          metadata: { supersededBy: personId },
        },
        tx,
      );
    }

    // Then acquire.
    const claimed = await tx.person.update({
      where: { id: personId },
      data: { ownerUserId: userId, claimedAt: new Date() },
    });

    // Everyone currently holding access, before the claimant's own membership
    // is written — so the claimant is never in their own revocation list.
    const incumbents = await tx.personMembership.findMany({
      where: { personId, status: 'ACTIVE', NOT: { userId } },
      select: {
        id: true,
        userId: true,
        role: true,
        user: { select: { firstName: true, lastName: true, email: true } },
      },
    });

    for (const incumbent of incumbents) {
      await tx.personMembership.update({
        where: { id: incumbent.id },
        data: { status: 'REVOKED', revokedAt: new Date(), receivesNotifications: false },
      });

      await personRepository.recordAccessEvent(
        {
          personId,
          subjectUserId: incumbent.userId,
          actorUserId: userId,
          action: 'REVOKED',
          role: incumbent.role,
          basis: 'claim-revoke',
        },
        tx,
      );
    }

    await tx.personMembership.upsert({
      where: { personId_userId: { personId, userId } },
      create: {
        personId,
        userId,
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
        subjectUserId: userId,
        actorUserId: userId,
        action: 'CLAIMED',
        role: 'OWNER',
        basis,
        metadata: {
          ...(supersededPersonId ? { supersededPersonId } : {}),
          // Named, not counted. The re-grant step has to know exactly whose
          // access this claim removed, and reconstructing that from timestamps
          // does not work: these rows and the REVOKED ones are written in one
          // transaction, so their ordering relative to each other is an
          // implementation detail of the writer, not something to query on.
          // No new disclosure — the REVOKED rows already name the same
          // accounts in `subjectUserId`, on the same ledger.
          revokedUserIds: incumbents.map((i) => i.userId),
        },
      },
      tx,
    );

    log.info('Person claimed', {
      personId,
      userId,
      supersededPersonId,
      revokedOnClaim: incumbents.length,
    });

    return {
      person: claimed,
      // Offered straight back so the client can put the re-grant decision on
      // the screen that follows the claim, rather than burying it in a
      // settings page nobody opens.
      revoked: incumbents.map((i) => ({
        userId: i.userId,
        role: i.role,
        name: [i.user.firstName, i.user.lastName].filter(Boolean).join(' ') || i.user.email,
      })),
    };
  },

  /**
   * Restore access to accounts the claim revoked. The second of the two
   * decisions.
   *
   * Bounded to exactly the accounts this claim took access from: the candidate
   * list is read out of the ledger, not off the request, so this cannot be
   * used to grant access to an arbitrary account. That path is `invite`, which
   * is an offer the recipient has to accept.
   *
   * Two consequences of that bound are worth stating.
   *
   * The grant lands ACTIVE rather than INVITED. Ordinarily consent is given by
   * the recipient and never assigned to them, and `invite` keeps that rule.
   * Here the recipient already held this access a moment ago and is not being
   * handed anything new — they are being left where they were — so requiring
   * them to re-accept would mean a caregiver silently losing a record because
   * they did not check their email. They can walk away at any time; `revoke`
   * already lets a member end their own membership whatever their role.
   *
   * And it bypasses the recipient's connection ceiling, for the same reason
   * `transferOwnership` bypasses the managed ceiling: this is a continuation,
   * not an acquisition. The record was theirs to manage under the *managed*
   * axis a moment ago and is now on the *connected* axis purely because the
   * claim set ownerUserId — the same relationship, re-classified by somebody
   * else's action. Charging them for that would make a claim quietly cost the
   * caregiver their access, which is the outcome the re-grant step exists to
   * prevent.
   */
  async regrantAfterClaim(
    actorUserId: string,
    personId: string,
    grants: Array<{ userId: string; role: 'CAREGIVER' | 'VIEWER' }>,
  ) {
    const person = await prisma.person.findUnique({
      where: { id: personId },
      select: { ownerUserId: true },
    });

    if (!person || person.ownerUserId !== actorUserId) {
      throw AppError.forbidden('Only the person this record belongs to can do this');
    }

    // The candidates: accounts this claim revoked, and nobody else. Read off
    // the claim event itself, which names them.
    const claimEvent = await prisma.personAccessEvent.findFirst({
      where: { personId, action: 'CLAIMED', subjectUserId: actorUserId },
      orderBy: { occurredAt: 'desc' },
      select: { metadata: true },
    });

    if (!claimEvent) {
      throw AppError.badRequest('This record was not claimed by this account');
    }

    const named = (claimEvent.metadata as { revokedUserIds?: unknown })?.revokedUserIds;
    const eligible = new Set(
      Array.isArray(named) ? named.filter((id): id is string => typeof id === 'string') : [],
    );

    const ineligible = grants.filter((g) => !eligible.has(g.userId));
    if (ineligible.length > 0) {
      throw AppError.badRequest(
        'Only accounts whose access this claim removed can be restored here. ' +
          'Invite anyone else instead.',
      );
    }

    return prisma.$transaction(async (tx) => {
      const restored: string[] = [];

      for (const grant of grants) {
        await tx.personMembership.upsert({
          where: { personId_userId: { personId, userId: grant.userId } },
          create: {
            personId,
            userId: grant.userId,
            role: grant.role,
            status: 'ACTIVE',
            receivesNotifications: false,
            acceptedAt: new Date(),
          },
          update: {
            role: grant.role,
            status: 'ACTIVE',
            acceptedAt: new Date(),
            revokedAt: null,
          },
        });

        await personRepository.recordAccessEvent(
          {
            personId,
            subjectUserId: grant.userId,
            actorUserId,
            action: 'GRANTED',
            role: grant.role,
            basis: 'claim-regrant',
            metadata: { ceilingBypassed: true },
          },
          tx,
        );

        restored.push(grant.userId);
      }

      log.info('Access restored after claim', {
        personId,
        actorUserId,
        restored: restored.length,
      });

      return { personId, restored };
    });
  },

  /**
   * Write the refusal to the ledger.
   *
   * The reason is deliberately absent from the row. `accessHistory` is
   * readable by everyone with read access to this Person — the inviter
   * included — and what is in the invitee's own health record is not the
   * inviter's to see. From the inviter's side a refused claim looks like an
   * ordinary invitation that was accepted as an ordinary connection, which is
   * exactly what it is.
   */
  async recordRefusal(input: {
    userId: string;
    personId: string;
    basis: string;
    tx?: PrismaTx;
  }) {
    await personRepository.recordAccessEvent(
      {
        personId: input.personId,
        subjectUserId: input.userId,
        actorUserId: input.userId,
        action: 'CLAIM_REFUSED',
        basis: input.basis,
      },
      input.tx,
    );

    log.info('Claim refused', { personId: input.personId, userId: input.userId });
  },
};
