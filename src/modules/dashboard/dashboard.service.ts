import { careRepository } from '@/modules/care/care.repository';
import { personAccess } from '@/modules/person/person.access';
import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { createLogger } from '@/lib/logger';

const log = createLogger('dashboard-service');

/**
 * The dashboard answers two different questions and must not blur them.
 *
 * `subject` and `care` are about a *body*: they follow the selected Person and
 * change when the switcher changes. `account` is about the *account* — quota,
 * billing, anything measured per login — and does not move.
 *
 * `people` is the third thing, and the reason it exists is honesty. A baby's
 * vaccination plan belongs to the baby, not the mother. Her dashboard should
 * still show it, but as a section named after that baby and reached through
 * her membership — not silently folded into her own clinical totals, which
 * would be a claim about her body that is not true.
 */
export const dashboardService = {
  async getDashboard(userId: string, requestedPersonId?: string) {
    const personId = await personAccess.resolveSubject(userId, requestedPersonId, 'read');

    const subject = await prisma.person.findUniqueOrThrow({
      where: { id: personId },
      select: { id: true, displayName: true, ownerUserId: true, origin: true },
    });

    const scope = { personId, userId };

    const [
      todayTasks,
      upcomingReminders,
      recentActivity,
      usageSummary,
      latestMoodInsight,
      journey,
      people,
    ] = await Promise.all([
      careRepository.getTodayCareEvents(scope),
      careRepository.getUpcomingCareEvents(scope, 5),
      careRepository.getRecentActivity(scope, 10),
      dashboardService.getUsageSummary(userId),
      dashboardService.getLatestMoodInsight(personId, userId),
      dashboardService.getJourneySummary(personId),
      dashboardService.getPeopleSummaries(userId, personId),
    ]);

    return {
      // Whose body this dashboard is about.
      subject: {
        personId: subject.id,
        displayName: subject.displayName,
        isSelf: subject.ownerUserId === userId,
      },

      // Person-scoped. Follows the switcher.
      care: {
        todayTasks,
        upcomingReminders,
        recentActivity,
        latestMoodInsight,
        journey,
      },

      // Account-scoped. Does not change when the person changes.
      account: {
        usageSummary,
      },

      // Everyone else this account can see, each named. Includes the selected
      // person so the switcher has a complete list.
      people,
    };
  },

  /**
   * Account-scoped: AI quota is metered per login, not per body. Scoping it to
   * a Person would make Persons a quota multiplier.
   */
  async getUsageSummary(userId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const usage = await prisma.dailyUsage.findUnique({
      where: { userId_date: { userId, date: today } },
    });

    return {
      symptomChecksUsed: usage?.symptomChecksUsed ?? 0,
      symptomChecksLimit: env.FREE_SYMPTOM_CHECKS_PER_DAY,
      drugDetectionsUsed: usage?.drugDetectionsUsed ?? 0,
      drugDetectionsLimit: env.FREE_DRUG_DETECTIONS_PER_DAY,
    };
  },

  async getLatestMoodInsight(personId: string, userId: string) {
    const latest = await prisma.moodLog.findFirst({
      where: {
        OR: [{ personId }, { personId: null, userId }],
      },
      orderBy: { loggedAt: 'desc' },
      select: { mood: true, craving: true, insight: true, loggedAt: true },
    });

    return latest ?? null;
  },

  /**
   * What is happening for *this* Person: their own pregnancy, their own
   * vaccination schedule. A baby has vaccinations and no pregnancies; a mother
   * has pregnancies and, after this change, no vaccination plans of her own.
   */
  async getJourneySummary(personId: string) {
    const [pregnancyGroups, vaccinationPlans] = await Promise.all([
      prisma.carePlan.groupBy({
        by: ['status'],
        where: { personId, type: 'PREGNANCY' },
        _count: true,
      }),
      prisma.carePlan.findMany({
        where: { personId, type: 'VACCINATION' },
        select: { id: true, status: true },
      }),
    ]);

    const total = pregnancyGroups.reduce((sum, g) => sum + g._count, 0);

    return {
      pregnancies: {
        total,
        active: pregnancyGroups.find((g) => g.status === 'ACTIVE')?._count ?? 0,
        completed: pregnancyGroups.find((g) => g.status === 'COMPLETED')?._count ?? 0,
      },
      vaccinations: {
        plans: vaccinationPlans.length,
        active: vaccinationPlans.filter((p) => p.status === 'ACTIVE').length,
      },
    };
  },

  /**
   * Every Person this account can read, each with a labelled summary.
   *
   * This is what keeps a mother's baby visible on her dashboard without
   * pretending the baby's vaccinations are hers. It doubles as the person
   * switcher's data source, so the client needs no second call.
   */
  async getPeopleSummaries(userId: string, selectedPersonId: string) {
    const memberships = await prisma.personMembership.findMany({
      where: {
        userId,
        status: 'ACTIVE',
        person: { archivedAt: null },
      },
      select: {
        role: true,
        person: {
          select: {
            id: true,
            displayName: true,
            ownerUserId: true,
            claimedAt: true,
            origin: true,
            dateOfBirth: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return Promise.all(
      memberships.map(async (m) => {
        const upcoming = await prisma.careEvent.count({
          where: {
            carePlan: { personId: m.person.id, status: 'ACTIVE' },
            status: 'PENDING',
            scheduledFor: { gt: new Date() },
          },
        });

        // Three distinct relationships, not two. `ownerUserId` says who has
        // claimed the record: nobody (a dependent this account manages), the
        // caller (their own), or another account (an adult who shared theirs).
        // Treating the third as "managed" was simply false.
        const relationship =
          m.person.ownerUserId === userId
            ? 'self'
            : m.person.ownerUserId === null
              ? 'managed'
              : 'connected';

        return {
          personId: m.person.id,
          displayName: m.person.displayName,
          // The label the client shows. Honest because it names the Person
          // and says how the caller reaches them.
          relationship,
          isClaimed: m.person.claimedAt !== null,
          origin: m.person.origin,
          role: m.role,
          isSelected: m.person.id === selectedPersonId,
          upcomingTasks: upcoming,
        };
      }),
    );
  },
};
