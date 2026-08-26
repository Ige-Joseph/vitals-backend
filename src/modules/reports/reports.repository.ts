import { prisma } from '@/lib/prisma';

/**
 * Everything a health summary is made of, read one Person at a time.
 *
 * Every query below is scoped by `personId` and takes it as an argument, never
 * as an optional filter. Authorization has already happened by the time
 * anything here runs — but a report is the one place in the codebase where a
 * missing scope would not merely leak a row, it would print somebody else's
 * medical history into a document and hand it over.
 *
 * The compatibility window is honoured the same way the care repository
 * honours it: rows written before their module started dual-writing carry
 * `personId = NULL`, and for a self-Person those are the caller's own records.
 * Including them by account is what stops a report of a long-standing account
 * silently omitting its own history. It never admits a row already carrying a
 * different subject.
 */

export interface ReportScope {
  personId: string;
  /** The owning account, for rows predating the personId backfill. */
  userId?: string;
}

export interface ReportPeriod {
  start: Date;
  end: Date;
}

const ownedBy = (scope: ReportScope) => ({
  OR: [
    { personId: scope.personId },
    ...(scope.userId ? [{ personId: null, userId: scope.userId }] : []),
  ],
});

export const reportsRepository = {
  person(personId: string) {
    return prisma.person.findUnique({
      where: { id: personId },
      include: { healthProfile: true },
    });
  },

  /**
   * Medication plans overlapping the period.
   *
   * Overlapping, not "started within" — a course begun last year and still
   * running is exactly what a clinician needs to see, and a naive filter on
   * `startDate` would drop it.
   */
  medications(scope: ReportScope, period: ReportPeriod) {
    return prisma.medication.findMany({
      where: {
        carePlan: { ...ownedBy(scope), type: 'MEDICATION' },
        startDate: { lte: period.end },
        OR: [{ endDate: null }, { endDate: { gte: period.start } }],
      },
      orderBy: { startDate: 'desc' },
      include: { carePlan: { select: { id: true, title: true, status: true } } },
    });
  },

  /**
   * Dose outcomes, grouped and counted.
   *
   * `groupBy` rather than fetching rows and counting in memory: a year of
   * four-times-daily doses is well over a thousand rows to answer a question
   * the database can answer in one pass.
   *
   * Counts of recorded states, and nothing derived from them.
   */
  doseCounts(scope: ReportScope, period: ReportPeriod) {
    return prisma.careEvent.groupBy({
      by: ['carePlanId', 'status'],
      where: {
        carePlan: { ...ownedBy(scope), type: 'MEDICATION' },
        scheduledFor: { gte: period.start, lte: period.end },
      },
      _count: { _all: true },
    });
  },

  appointments(personId: string, period: ReportPeriod) {
    return prisma.appointment.findMany({
      where: {
        personId,
        startsAt: { gte: period.start, lte: period.end },
      },
      orderBy: { startsAt: 'asc' },
      include: { carePlan: { select: { title: true } } },
    });
  },

  /**
   * Symptoms as the Person recorded them.
   *
   * `aiResponse` is deliberately not selected. It is model output, not
   * something anyone recorded, and in a document a clinician reads it would
   * carry the weight of an assessment. Vitals does not assess.
   */
  symptoms(scope: ReportScope, period: ReportPeriod) {
    return prisma.symptomLog.findMany({
      where: { ...ownedBy(scope), createdAt: { gte: period.start, lte: period.end } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, symptomsText: true, severity: true, createdAt: true },
    });
  },

  /** Mood and cravings as recorded. `insight` is model output and is not read. */
  moods(scope: ReportScope, period: ReportPeriod) {
    return prisma.moodLog.findMany({
      where: { ...ownedBy(scope), loggedAt: { gte: period.start, lte: period.end } },
      orderBy: { loggedAt: 'desc' },
      select: { id: true, mood: true, craving: true, loggedAt: true },
    });
  },

  /** The pregnancy record, if there is a live one. */
  pregnancy(scope: ReportScope) {
    return prisma.pregnancyProfile.findFirst({
      where: { carePlan: { ...ownedBy(scope), type: 'PREGNANCY', status: 'ACTIVE' } },
      orderBy: { createdAt: 'desc' },
    });
  },

  /** The fact of a generation. Never a file. */
  recordGeneration(data: {
    personId: string;
    generatedByUserId: string;
    periodStart: Date;
    periodEnd: Date;
  }) {
    return prisma.reportGeneration.create({ data });
  },

  listGenerations(personId: string, limit = 50) {
    return prisma.reportGeneration.findMany({
      where: { personId },
      orderBy: { generatedAt: 'desc' },
      take: limit,
    });
  },
};
