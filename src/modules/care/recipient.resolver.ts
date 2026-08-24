import { prisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';

const log = createLogger('recipient-resolver');

export interface Recipient {
  id: string;
  email: string;
  timezone?: string | null;
}

/**
 * Who receives a notification about a care plan.
 *
 * The Person owns the clinical event; delivery is account-scoped. Before the
 * separation these were the same thing and the engine simply read
 * `careEvent.carePlan.user` — one line where subject collapsed into recipient.
 * Resolving here instead means the answer is computed at delivery time from
 * current state, so a membership revoked, an account deactivated or a record
 * claimed between scheduling and sending is honoured rather than ignored.
 *
 * Connected-account routing is deliberately not built: only memberships
 * flagged `receivesNotifications` are considered, and phase B sets that flag
 * on exactly one membership per Person — the managing OWNER.
 */
export const recipientResolver = {
  async forCarePlan(carePlan: {
    id: string;
    userId: string;
    personId: string | null;
  }): Promise<Recipient[]> {
    if (carePlan.personId) {
      const memberships = await prisma.personMembership.findMany({
        where: {
          personId: carePlan.personId,
          status: 'ACTIVE',
          receivesNotifications: true,
          // An archived or erased account cannot receive care reminders.
          // Nothing consulted isActive before this.
          user: { isActive: true, erasedAt: null },
        },
        select: {
          user: {
            select: {
              id: true,
              email: true,
              profile: { select: { timezone: true } },
            },
          },
        },
      });

      return memberships.map((m) => ({
        id: m.user.id,
        email: m.user.email,
        timezone: m.user.profile?.timezone ?? null,
      }));
    }

    // Compatibility path: a care plan whose personId has not been backfilled
    // still routes by account. userId remains authoritative until every row
    // carries a subject, so this must stay until the column is NOT NULL.
    const user = await prisma.user.findFirst({
      where: { id: carePlan.userId, isActive: true, erasedAt: null },
      select: {
        id: true,
        email: true,
        profile: { select: { timezone: true } },
      },
    });

    if (!user) {
      log.warn('Care plan has no personId and its account is not deliverable', {
        carePlanId: carePlan.id,
      });
      return [];
    }

    return [{ id: user.id, email: user.email, timezone: user.profile?.timezone ?? null }];
  },
};
