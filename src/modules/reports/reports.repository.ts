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

  // ── The asynchronous lifecycle ────────────────────────────────────────

  /** A request, before anything has been rendered. */
  createPending(data: {
    personId: string;
    generatedByUserId: string;
    periodStart: Date;
    periodEnd: Date;
  }) {
    return prisma.reportGeneration.create({ data, select: GENERATION_VIEW });
  },

  generationById(id: string) {
    return prisma.reportGeneration.findUnique({
      where: { id },
      select: { ...GENERATION_VIEW, generatedByUserId: true, storageKey: true },
    });
  },

  /**
   * Take ownership of a pending row, or report that someone already has.
   *
   * The conditional update is the claim: only a row still PENDING moves to
   * PROCESSING, and `count` says whether this caller was the one that moved
   * it. BullMQ already delivers a job once, but a queue replayed after a flush
   * — or a job retried after the process died mid-render — can arrive at a row
   * that is no longer waiting, and rendering one health summary twice is worth
   * one cheap guard.
   */
  async claimForRendering(id: string): Promise<boolean> {
    const { count } = await prisma.reportGeneration.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'PROCESSING' },
    });
    return count === 1;
  },

  markReady(id: string, storageKey: string, expiresAt: Date) {
    return prisma.reportGeneration.update({
      where: { id },
      data: { status: 'READY', storageKey, expiresAt, completedAt: new Date() },
      select: GENERATION_VIEW,
    });
  },

  markFailed(id: string, failureReason: string) {
    return prisma.reportGeneration.update({
      where: { id },
      data: { status: 'FAILED', failureReason, completedAt: new Date() },
      select: GENERATION_VIEW,
    });
  },

  /**
   * Record that a copy left the system.
   *
   * Only the first fetch is stamped. The ledger's question is whether this
   * Person's history left, not how many times the reader pressed the button,
   * and overwriting it on every download would lose the moment it happened.
   */
  async markDownloaded(id: string): Promise<void> {
    await prisma.reportGeneration.updateMany({
      where: { id, downloadedAt: null },
      data: { downloadedAt: new Date() },
    });
  },

  /** READY rows whose document is due for deletion. */
  dueForExpiry(now: Date, limit = 200) {
    return prisma.reportGeneration.findMany({
      where: { status: 'READY', expiresAt: { lte: now } },
      select: { id: true, storageKey: true },
      take: limit,
    });
  },

  /**
   * Move a swept row to EXPIRED.
   *
   * `storageKey` is cleared at the same time: the file is gone, and a key
   * pointing at nothing invites a later reader to believe otherwise.
   */
  async markExpired(id: string): Promise<void> {
    await prisma.reportGeneration.updateMany({
      where: { id, status: 'READY' },
      data: { status: 'EXPIRED', storageKey: null },
    });
  },

  /** Every key a row still claims, for detecting files nothing owns. */
  async liveStorageKeys(): Promise<Set<string>> {
    const rows = await prisma.reportGeneration.findMany({
      where: { storageKey: { not: null } },
      select: { storageKey: true },
    });
    return new Set(rows.map((row) => row.storageKey!));
  },
};

/**
 * What a caller may see about a generation.
 *
 * `storageKey` is deliberately absent: it names a file on the server and no
 * client has any use for it. It is selected explicitly where the server needs
 * it, and nowhere else.
 */
const GENERATION_VIEW = {
  id: true,
  personId: true,
  kind: true,
  status: true,
  periodStart: true,
  periodEnd: true,
  generatedAt: true,
  completedAt: true,
  expiresAt: true,
  downloadedAt: true,
  failureReason: true,
} as const;
