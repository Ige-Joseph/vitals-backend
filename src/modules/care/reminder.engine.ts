import { prisma } from '@/lib/prisma';
import { careRepository } from '@/modules/care/care.repository';
import { recipientResolver } from '@/modules/care/recipient.resolver';
import { outboxRepository } from '@/modules/outbox/outbox.repository';
import { pushProvider } from '@/providers/push/push.provider';
import { adherenceQueue, JOB_NAMES } from '@/queues/queue.registry';
import { env } from '@/config/env';
import { createLogger } from '@/lib/logger';
import type { PrismaTx } from '@/types/prisma';

const log = createLogger('reminder-engine');

/**
 * Turn a care event into the notification a recipient actually sees.
 *
 * Two problems this fixes, both only visible to someone holding more than one
 * record. The notification said "Take Metformin" with no indication of whose
 * dose it was, and its link was a constant `/care` — which opens the
 * *recipient's own* care page, so a caregiver tapping a reminder about their
 * father landed on their own medications.
 *
 * What it does not do is say more than it has to. For a recipient's own
 * reminder nothing changes at all: no name is prefixed and the destination
 * stays `/care`, so the common case is byte-identical to before and no extra
 * detail reaches a lock screen that was not already there.
 *
 * For someone else's record the display name is prefixed, because a stable id
 * on a lock screen tells a human nothing — identifying the person *is* the
 * requirement. The id travels in the link instead, where it is what the app
 * needs and not what the reader sees. No clinical detail is added either way:
 * title and body are the same strings the event already carried.
 */
export const buildReminderPush = (
  careEvent: {
    title: string;
    description?: string | null;
    carePlan?: {
      person?: { id: string; displayName: string; ownerUserId: string | null } | null;
    } | null;
  },
  recipientUserId: string,
): { title: string; body: string; url: string } => {
  const person = careEvent.carePlan?.person ?? null;
  const body = careEvent.description ?? 'You have a care event due';

  // No person row means a plan written before the subject column was
  // populated. Those are the recipient's own by construction, so they keep
  // exactly the notification they have today.
  const isSelf = !person || person.ownerUserId === recipientUserId;

  if (isSelf) {
    return { title: careEvent.title, body, url: '/care' };
  }

  return {
    title: `${person.displayName} — ${careEvent.title}`,
    body,
    // `/dashboard` rather than `/care`: it is the only screen that scopes to a
    // Person, and it already passes personId to the API. `/care` ignores the
    // parameter entirely, so linking there would look correct and quietly show
    // the wrong record — the bug this replaces.
    url: `/dashboard?personId=${encodeURIComponent(person.id)}`,
  };
};

export const reminderEngine = {
  async processDueReminders(): Promise<void> {
    const missed = await careRepository.markOverdueEventsMissed(env.MISSED_WINDOW_MS);
    if ((missed as any).count > 0) {
      log.info('Marked overdue events as missed', { count: (missed as any).count });
    }

    const reminders = await careRepository.findDueReminders(100);
    if (reminders.length === 0) return;

    log.info(`Processing ${reminders.length} due reminders`);

    for (const reminder of reminders) {
      await reminderEngine.dispatchReminder(reminder);
    }
  },

  async dispatchReminder(reminder: any): Promise<void> {
    const reminderId = reminder.id;

    const claimed = await careRepository.claimReminder(reminderId);
    if (claimed.count === 0) {
      log.debug('Reminder already claimed or processed, skipping', { reminderId });
      return;
    }

    const freshReminder = await prisma.reminder.findUnique({
      where: { id: reminderId },
      include: {
        careEvent: {
          include: {
            carePlan: {
              include: {
                user: {
                  select: {
                    id: true,
                    email: true,
                    profile: { select: { timezone: true } },
                  },
                },
                medication: { select: { name: true } },
                // Whose body this is. Needed to say so in the notification: a
                // caregiver holding several records cannot act on "time for
                // your 8am dose" without being told whose dose it is.
                person: { select: { id: true, displayName: true, ownerUserId: true } },
              },
            },
          },
        },
      },
    });

    if (!freshReminder) {
      log.warn('Claimed reminder no longer exists', { reminderId });
      return;
    }

    const careEvent = freshReminder.careEvent;
    const carePlan = careEvent.carePlan;

    if (carePlan.status !== 'ACTIVE' || careEvent.status !== 'PENDING') {
      await careRepository.updateReminderStatus(reminderId, 'CANCELLED');
      log.info('Reminder cancelled because event/plan is no longer active', {
        reminderId,
        careEventStatus: careEvent.status,
        carePlanStatus: carePlan.status,
      });
      return;
    }

    const medicationName = carePlan.medication?.name ?? 'medication';

    // Resolve who receives this at delivery time rather than trusting whoever
    // was named when it was scheduled.
    const recipients = await recipientResolver.forCarePlan({
      id: carePlan.id,
      userId: carePlan.userId,
      personId: (carePlan as any).personId ?? null,
    });

    if (recipients.length === 0) {
      await reminderEngine.failNoEligibleRecipient(freshReminder, carePlan);
      return;
    }

    // Delivery is account-scoped and connected-account routing is out of
    // scope, so exactly one membership per Person carries the flag today.
    const user = recipients[0];

    // Every reminder this codebase creates is PUSH. EMAIL exists in the enum
    // and nothing writes it, and this used to mark such a reminder SENT
    // without sending anything — the one failure mode you cannot detect
    // afterwards, because the row claims delivery.
    //
    // It fails outright rather than falling through to the email fallback
    // below: routing it there would quietly turn EMAIL into a working delivery
    // channel, which is a product surface this task is not expanding. A
    // channel nothing creates is better left unimplemented and loud.
    if (freshReminder.channel !== 'PUSH') {
      await careRepository.updateReminderStatus(
        reminderId,
        'FAILED',
        undefined,
        `UNSUPPORTED_CHANNEL:${freshReminder.channel}`,
      );

      log.error('Reminder has a channel with no dispatcher — not delivered', {
        reminderId,
        channel: freshReminder.channel,
        carePlanId: carePlan.id,
      });
      return;
    }

    try {
      await reminderEngine.sendPushReminder(freshReminder, user, careEvent, medicationName);
    } catch (err: any) {
      log.error('Failed to dispatch reminder', { reminderId, error: err.message });

      const fallbackQueued = await reminderEngine.tryQueueFallbackEmail(
        freshReminder,
        user,
        careEvent,
        medicationName,
        `Push dispatch error: ${err.message}`,
      );

      if (fallbackQueued) {
        await careRepository.updateReminderStatus(reminderId, 'SENT');
        return;
      }

      await careRepository.updateReminderStatus(
        reminderId,
        'FAILED',
        undefined,
        err.message,
      );
    }
  },

  /**
   * A due reminder that resolves to nobody must never be dropped quietly.
   *
   * Blocking deactivation of a sole OWNER prevents the common cause, but every
   * other route to an empty recipient set — a revoked membership, an erased
   * account, a plan whose subject was archived — ends here. The reminder is
   * marked FAILED with a distinct reason and an attempt row is written, so
   * "nobody was told" is queryable rather than invisible.
   */
  async failNoEligibleRecipient(reminder: any, carePlan: any): Promise<void> {
    const reason = 'NO_ELIGIBLE_RECIPIENT';

    try {
      await prisma.notificationAttempt.create({
        data: {
          reminderId: reminder.id,
          channel: reminder.channel,
          type: 'PUSH_PRIMARY',
          status: 'SKIPPED',
          // Deterministic, so a retry records the fact once rather than
          // accumulating a row per attempt.
          idempotencyKey: `no-recipient:${reminder.id}`,
          errorMessage: reason,
        },
      });
    } catch {
      // Unique violation — already recorded for this reminder.
    }

    await careRepository.updateReminderStatus(reminder.id, 'FAILED', undefined, reason);

    log.error('Reminder had no eligible recipient and was not delivered', {
      reminderId: reminder.id,
      carePlanId: carePlan.id,
      personId: carePlan.personId ?? null,
      accountId: carePlan.userId,
    });
  },

  async sendPushReminder(
    reminder: any,
    user: any,
    careEvent: any,
    medicationName: string,
  ): Promise<void> {
    const reminderId = reminder.id;

    const pushTokens = await prisma.pushToken.findMany({
      where: { userId: user.id },
      select: { id: true, token: true },
    });

    if (pushTokens.length === 0) {
      log.info('No FCM tokens for user — queueing fallback email', {
        userId: user.id,
        reminderId,
      });

      const fallbackQueued = await reminderEngine.tryQueueFallbackEmail(
        reminder,
        user,
        careEvent,
        medicationName,
        'No FCM tokens available',
      );

      if (fallbackQueued) {
        await careRepository.updateReminderStatus(reminderId, 'SENT');
        return;
      }

      await careRepository.updateReminderStatus(
        reminderId,
        'FAILED',
        undefined,
        'No FCM tokens available and fallback email could not be queued',
      );
      return;
    }

    const { sent, failed, invalidTokenIds } = await pushProvider.sendToUserTokens(
      pushTokens,
      buildReminderPush(careEvent, user.id),
    );

    if (invalidTokenIds.length > 0) {
      await prisma.pushToken.deleteMany({
        where: { id: { in: invalidTokenIds } },
      });

      log.info('Removed invalid FCM tokens', {
        count: invalidTokenIds.length,
        userId: user.id,
      });
    }

    log.info('Push reminder dispatched', { reminderId, sent, failed });

    if (sent > 0) {
      const adherenceCheckDueAt =
        careEvent.eventType === 'MEDICATION_DOSE'
          ? new Date(Date.now() + env.ADHERENCE_CHECK_DELAY_MS)
          : undefined;

      await prisma.$transaction(async (tx: PrismaTx) => {
        if (adherenceCheckDueAt) {
          await careRepository.updateReminderStatus(
            reminderId,
            'SENT',
            tx,
            undefined,
            {
              adherenceCheckDueAt,
            },
          );
        } else {
          await careRepository.updateReminderStatus(reminderId, 'SENT', tx);
        }

        await careRepository.createActivityLog(
          {
            userId: user.id,
            type: 'REMINDER_SENT',
            message: `Push reminder sent for: ${careEvent.title}`,
            metadata: { reminderId, sent, failed },
          },
          tx,
        );
      });

      if (adherenceCheckDueAt) {
        try {
          await adherenceQueue.add(
            JOB_NAMES.CHECK_MEDICATION_ADHERENCE,
            {
              reminderId,
              careEventId: careEvent.id,
              // Whose dose this is. Who to tell is resolved when the check runs,
              // half an hour later, by which time the answer may have changed.
              personId: careEvent.carePlan?.personId ?? undefined,
              medicationName,
              scheduledFor: careEvent.scheduledFor.toISOString(),
            },
            {
              delay: env.ADHERENCE_CHECK_DELAY_MS,
              jobId: `adherence-${reminderId}`,
              attempts: 1,
            },
          );

          log.info('Adherence check scheduled', {
            reminderId,
            delayMs: env.ADHERENCE_CHECK_DELAY_MS,
          });
        } catch (err: any) {
          log.warn('Failed to enqueue adherence check; durable due row remains', {
            reminderId,
            error: err.message,
          });
        }
      }

      return;
    }

    const fallbackQueued = await reminderEngine.tryQueueFallbackEmail(
      reminder,
      user,
      careEvent,
      medicationName,
      `Push failed for all tokens (${failed} failures)`,
    );

    if (fallbackQueued) {
      await careRepository.updateReminderStatus(reminderId, 'SENT');
      return;
    }

    await careRepository.updateReminderStatus(
      reminderId,
      'FAILED',
      undefined,
      `Push failed for all tokens (${failed} failures)`,
    );
  },

  /**
   * Queue an email because push could not deliver.
   *
   * Previously guarded to `MEDICATION_DOSE`, which meant a user with no FCM
   * token registered — the default state, since push needs an explicit browser
   * grant — got every dose reminder by email and was told nothing at all about
   * an antenatal visit or a baby vaccination. That inverts the stakes: a missed
   * dose is recoverable at the next one, a missed vaccination window is not.
   *
   * The guard is gone. Everything else is unchanged and deliberately so — same
   * outbox row, same queue, same worker case, same adapter. This is the
   * existing mechanism carrying more event types, not a second one.
   *
   * The outbox type is still `MEDICATION_FALLBACK_EMAIL` and now covers care
   * events that are not medication. Renaming it needs an enum migration, and
   * an enum migration cannot be rehearsed against populated data here, so the
   * inaccurate name is the deliberate lesser cost. Rename it when there is a
   * migration window — see the report.
   *
   * This is *not* the +30 minute adherence chase. That lives in
   * adherence.worker.ts, is scheduled only for `MEDICATION_DOSE`, and stays
   * medication-only: asking whether someone took their antenatal appointment
   * would be nonsense.
   */
  async tryQueueFallbackEmail(
    reminder: any,
    user: any,
    careEvent: any,
    medicationName: string,
    reason: string,
  ): Promise<boolean> {
    try {
      await outboxRepository.create({
        userId: user.id,
        type: 'MEDICATION_FALLBACK_EMAIL',
        payload: {
          personId: careEvent.carePlan?.personId ?? undefined,
          reminderId: reminder.id,
          careEventId: careEvent.id,
          // What kind of care event this was, so the worker can pick a
          // template instead of calling everything a medication.
          eventType: careEvent.eventType,
          medicationName,
          title: careEvent.title,
          description: careEvent.description ?? null,
          scheduledFor: careEvent.scheduledFor.toISOString(),
          reason,
        },
      });

      log.info('Fallback email queued', {
        reminderId: reminder.id,
        userId: user.id,
        eventType: careEvent.eventType,
        reason,
      });

      return true;
    } catch (err: any) {
      log.error('Failed to queue fallback email', {
        reminderId: reminder.id,
        userId: user.id,
        error: err.message,
      });

      return false;
    }
  },
};
