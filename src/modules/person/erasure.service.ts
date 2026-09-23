import { randomUUID } from 'node:crypto';

import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { googleCalendarProvider } from '@/providers/calendar/google-calendar.provider';
import { personRepository } from './person.repository';
import { personService } from './person.service';
import { subscriptionService } from '@/modules/billing/subscription.service';

const log = createLogger('erasure-service');

/**
 * Erasure = irreversible field-level destruction plus a tombstone.
 *
 * The tension between "archive, never delete" and a data subject's deletion
 * right only exists if erasure is assumed to mean dropping the `users` row. It
 * does not have to. Destroying the personal data satisfies the right; keeping
 * an emptied row means the Restrict foreign keys added in phase C never have
 * to be defeated, and other people's history keeps its shape.
 *
 * What is destroyed:
 *   - credentials, refresh / verification / reset tokens
 *   - push tokens and subscriptions
 *   - calendar integrations, with the grant revoked at Google
 *   - the account's own self-Person and its clinical data
 *
 * What is kept, with the account's identity removed:
 *   - clinical rows belonging to *other* Persons, with createdBy / actor
 *     references nulled — attribution, never subject
 *   - consent ledger entries, because another person's record of who had
 *     access to their health data is that person's data
 */
export const erasureService = {
  async execute(userId: string, actorUserId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, erasedAt: true, erasureStatus: true },
    });

    if (!user) throw AppError.notFound('User not found');
    if (user.erasedAt) throw AppError.conflict('This account has already been erased');

    // Re-check rather than trusting the stored status: a Person may have been
    // handed to this account since the request was made.
    await personService.assertCanArchiveAccount(userId);

    // Stop being charged. Best-effort at the provider and never fatal: the
    // right to erasure does not depend on a payment provider being reachable.
    // An unconfirmed cancellation is recorded on the subscription for
    // reconciliation to retry.
    const billing = await subscriptionService.cancelAllForAccount(userId, 'account-erasure');

    // Revoke remote grants before dropping the rows that hold the tokens —
    // afterwards we no longer know what to revoke.
    const integrations = await prisma.calendarIntegration.findMany({
      where: { userId },
      select: { id: true, refreshToken: true },
    });

    let revoked = 0;
    for (const integration of integrations) {
      if (await googleCalendarProvider.revokeGrant(integration.refreshToken)) revoked += 1;
    }

    const selfPerson = await prisma.person.findFirst({
      where: { ownerUserId: userId },
      select: { id: true },
    });

    const result = await prisma.$transaction(async (tx) => {
      // 1. Credentials and devices — the account's own, destroyed outright.
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.emailVerificationToken.deleteMany({ where: { userId } });
      await tx.passwordResetToken.deleteMany({ where: { userId } });
      await tx.pushToken.deleteMany({ where: { userId } });
      await tx.pushSubscription.deleteMany({ where: { userId } });
      await tx.calendarIntegration.deleteMany({ where: { userId } });

      // 2. The account's own health record. The requester is the subject here,
      //    so this really is destroyed rather than archived.
      let clinicalDestroyed = 0;
      if (selfPerson) {
        const plans = await tx.carePlan.findMany({
          where: { personId: selfPerson.id },
          select: { id: true },
        });
        const planIds = plans.map((p) => p.id);

        if (planIds.length > 0) {
          // CareEvent cascades from CarePlan, Reminder from CareEvent, and
          // NotificationAttempt from Reminder — those relations are unchanged.
          await tx.calendarEventLink.deleteMany({
            where: { careEvent: { carePlanId: { in: planIds } } },
          });
        }

        const [sym, mood, drug, draft, act, plan] = await Promise.all([
          tx.symptomLog.deleteMany({ where: { personId: selfPerson.id } }),
          tx.moodLog.deleteMany({ where: { personId: selfPerson.id } }),
          tx.drugDetection.deleteMany({ where: { personId: selfPerson.id } }),
          tx.medicationDraft.deleteMany({ where: { personId: selfPerson.id } }),
          tx.activityLog.deleteMany({ where: { personId: selfPerson.id } }),
          tx.carePlan.deleteMany({ where: { personId: selfPerson.id } }),
        ]);

        clinicalDestroyed =
          sym.count + mood.count + drug.count + draft.count + act.count + plan.count;

        await personRepository.recordAccessEvent(
          {
            personId: selfPerson.id,
            subjectUserId: null,
            actorUserId: null,
            action: 'ERASED',
            basis: 'erasure',
            metadata: { clinicalRowsDestroyed: clinicalDestroyed },
          },
          tx,
        );

        await tx.personHealthProfile.deleteMany({ where: { personId: selfPerson.id } });
        await tx.personMembership.deleteMany({ where: { personId: selfPerson.id } });

        // The Person row is tombstoned rather than deleted, for the same
        // reason the users row is: the consent ledger references it and is
        // append-only, so deleting the Person would either fail against
        // Restrict or force us to destroy entries recording who had access.
        // Every identifying attribute is cleared, the clinical data is gone,
        // and releasing ownerUserId frees the unique slot.
        await tx.person.update({
          where: { id: selfPerson.id },
          data: {
            displayName: 'Erased',
            dateOfBirth: null,
            gender: null,
            ownerUserId: null,
            createdByUserId: null,
            archivedAt: new Date(),
          },
        });
      }

      // 3. Billing records survive with their personal link removed. A refund
      //    can arrive weeks from now and still has to land somewhere.
      await subscriptionService.detachFromErasedAccount(userId, tx);

      // 4. Memberships this account held over *other* Persons. Removing access
      //    never removes their data.
      await tx.personMembership.deleteMany({ where: { userId } });

      // 5. Strip identity from rows that survive because they belong to
      //    someone else. Both columns are attribution and are never read for
      //    authorization, which is what makes this safe.
      await tx.person.updateMany({
        where: { createdByUserId: userId },
        data: { createdByUserId: null },
      });
      await tx.activityLog.updateMany({
        where: { actorUserId: userId },
        data: { actorUserId: null },
      });
      await tx.personAccessEvent.updateMany({
        where: { actorUserId: userId },
        data: { actorUserId: null },
      });
      await tx.personAccessEvent.updateMany({
        where: { subjectUserId: userId },
        data: { subjectUserId: null },
      });

      // 6. Tombstone. The row survives carrying no personal data, so Restrict
      //    is never defeated and the original address is freed for re-signup.
      await tx.user.update({
        where: { id: userId },
        data: {
          email: `erased-${randomUUID()}@invalid`,
          firstName: null,
          lastName: null,
          passwordHash: '',
          isActive: false,
          erasedAt: new Date(),
          erasureStatus: 'EXECUTED',
          erasureBlockedReason: null,
        },
      });

      await tx.profile.deleteMany({ where: { userId } });

      return { clinicalDestroyed };
    });

    log.info('Account erased', {
      userId,
      actorUserId,
      subscriptionsCancelled: billing.cancelled,
      cancellationsUnconfirmed: billing.unconfirmed,
      grantsRevoked: revoked,
      integrations: integrations.length,
      clinicalRowsDestroyed: result.clinicalDestroyed,
    });

    return {
      userId,
      subscriptionsCancelled: billing.cancelled,
      cancellationsUnconfirmed: billing.unconfirmed,
      grantsRevoked: revoked,
      clinicalRowsDestroyed: result.clinicalDestroyed,
    };
  },
};
