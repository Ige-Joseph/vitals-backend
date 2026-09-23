import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { env } from '@/config/env';
import { personAccess } from '@/modules/person/person.access';
import { entitlementService } from '@/modules/billing/entitlement.service';
import {
  reportsQueue,
  JOB_NAMES,
  type GenerateHealthSummaryPayload,
} from '@/queues/queue.registry';
import { reportsRepository, type ReportPeriod } from './reports.repository';
import { renderHealthSummary } from './reports.pdf';
import {
  newStorageKey,
  openWriteStream,
  openReadStream,
  fileSize,
  deleteFile,
  orphanedFiles,
} from './reports.storage';

const log = createLogger('reports');

/**
 * Health summaries.
 *
 * ── Why this IS a background job, and what that cost ─────────────────────
 *
 * This file used to argue the opposite, and the argument was right about the
 * risk while being wrong about the machine. It is kept in outline because the
 * risk did not go away by being accepted.
 *
 * The objection was never that rendering is fast or slow. It was that making
 * it a job adds a stored artifact — a PDF holding one Person's entire health
 * record, duplicated outside the tables that own it and outside every access
 * check that guards them, sitting somewhere until someone remembers to delete
 * it. That is still exactly what a stored report is.
 *
 * What changed is where this runs: a 1 GB instance on which the API and the
 * worker share a single Node process. PDFKit rendering is the most CPU-hungry
 * thing that process does, and on the request path it competes with every
 * other request for the same event loop — including the reminder engine.
 * "Slow" was never the danger; blocking was.
 *
 * The earlier note named the escape hatch and this is it, taken deliberately:
 * "accept a job whose output is deleted on a timer. It is not to quietly start
 * storing health records." So the timer is not a follow-up task. Nothing in
 * this module can produce a file without an expiry:
 *
 *   * expiresAt is written in the same update that sets READY
 *   * the sweep deletes the file and moves the row to EXPIRED
 *   * files nothing owns are swept too, so a crash mid-render cannot leave a
 *     health record on disk with no row tracking its deletion
 *
 * ── Downloads are authorised, not addressed ──────────────────────────────
 *
 * A signed storage URL was the obvious way to serve these and is deliberately
 * not used. Such a URL is a bearer capability: it keeps working after the
 * membership that justified it is revoked, because nothing re-reads the
 * membership. Access here is resolved from the database on *every* download,
 * so revocation takes effect between two fetches of the same document. The
 * storage key never leaves the server and is not part of any response.
 *
 * ── Two gates, resolved separately ───────────────────────────────────────
 *
 * Membership decides *whose* record may be summarised. Entitlement decides
 * whether *this account* may generate a summary at all. They are independent
 * and both are checked server-side: a Premium account still cannot report on a
 * stranger, and an OWNER on the free tier still cannot export.
 *
 * Order matters slightly and is deliberate — access first. Someone with no
 * relationship to a Person should be told they cannot see that Person, not
 * that they should upgrade in order to find out.
 */

export interface HealthSummary {
  person: {
    id: string;
    displayName: string;
    dateOfBirth: Date | null;
    gender: string | null;
  };
  healthProfile: {
    bloodGroup: string | null;
    genotype: string | null;
    heightCm: number | null;
    weightKg: number | null;
    allergies: string[];
    existingConditions: string[];
    currentMedications: string[];
    disabilities: string[];
    smokingStatus: string | null;
    alcoholUse: string | null;
  } | null;
  pregnancy: {
    lmpDate: Date;
    expectedDeliveryDate: Date;
    currentWeek: number;
    trimester: number;
  } | null;
  medications: Array<{
    name: string;
    dosage: string;
    frequency: string;
    startDate: Date;
    endDate: Date | null;
    instructions: string | null;
    planStatus: string;
    doses: DoseCounts;
  }>;
  doseTotals: DoseCounts;
  appointments: Array<{
    title: string;
    startsAt: Date;
    durationMinutes: number;
    status: string;
    clinician: string | null;
    specialty: string | null;
    location: string | null;
    reason: string | null;
    notes: string | null;
    cancellationReason: string | null;
  }>;
  appointmentTotals: {
    attended: number;
    cancelled: number;
    missed: number;
    scheduled: number;
  };
  symptoms: Array<{ symptomsText: string; severity: string | null; createdAt: Date }>;
  moods: Array<{ mood: string | null; craving: string | null; loggedAt: Date }>;
  period: ReportPeriod;
  generatedAt: Date;
  /** True when every section is empty, so the document can say so once. */
  isEmpty: boolean;
}

/**
 * The four recorded outcomes. Counts of what happened, and nothing derived.
 *
 * No fifth field is computed from these and none should be: a ratio of taken
 * to scheduled is an adherence figure, and an adherence figure is an
 * assessment of how someone is managing their health.
 */
export interface DoseCounts {
  taken: number;
  skipped: number;
  missed: number;
  scheduled: number;
}

const emptyCounts = (): DoseCounts => ({ taken: 0, skipped: 0, missed: 0, scheduled: 0 });

/** CareEventStatus, as recorded, mapped to the words the document uses. */
const COUNT_KEY: Record<string, keyof DoseCounts> = {
  DONE: 'taken',
  SKIPPED: 'skipped',
  MISSED: 'missed',
  PENDING: 'scheduled',
};

export const reportsService = {
  /**
   * Gather everything, for one Person, over one period.
   *
   * Public so the tests can assert on the data without rendering a PDF, and so
   * a future in-app view can render the same summary without a second query
   * path that might drift from this one.
   */
  async buildHealthSummary(
    userId: string,
    requestedPersonId: string | undefined,
    period: ReportPeriod,
  ): Promise<HealthSummary> {
    // Gate one: whose record. Read access is enough — a report copies out what
    // the reader can already see.
    const personId = await personAccess.resolveSubject(userId, requestedPersonId, 'read');

    // Gate two: may this account export at all. Independent of the first, and
    // resolved from the subscription rather than from a column on the token.
    const tier = await entitlementService.tierFor(userId);
    if (tier !== 'PREMIUM') {
      throw AppError.forbidden(
        'Generating a health summary is a Premium feature.',
      );
    }

    if (period.end < period.start) {
      throw AppError.badRequest('The end of the period must be after its start');
    }

    const person = await reportsRepository.person(personId);
    if (!person) throw AppError.notFound('Person not found');

    // The compatibility window: for a self-Person, rows written before the
    // personId backfill belong to this account and are still this Person's.
    const scope = { personId, userId: person.ownerUserId ?? undefined };

    const [medications, doseRows, appointments, symptoms, moods, pregnancy] =
      await Promise.all([
        reportsRepository.medications(scope, period),
        reportsRepository.doseCounts(scope, period),
        reportsRepository.appointments(personId, period),
        reportsRepository.symptoms(scope, period),
        reportsRepository.moods(scope, period),
        reportsRepository.pregnancy(scope),
      ]);

    const countsByPlan = new Map<string, DoseCounts>();
    for (const row of doseRows) {
      const key = COUNT_KEY[row.status];
      if (!key) continue;
      const counts = countsByPlan.get(row.carePlanId) ?? emptyCounts();
      counts[key] += row._count._all;
      countsByPlan.set(row.carePlanId, counts);
    }

    const doseTotals = emptyCounts();
    for (const counts of countsByPlan.values()) {
      doseTotals.taken += counts.taken;
      doseTotals.skipped += counts.skipped;
      doseTotals.missed += counts.missed;
      doseTotals.scheduled += counts.scheduled;
    }

    const appointmentTotals = { attended: 0, cancelled: 0, missed: 0, scheduled: 0 };
    for (const appointment of appointments) {
      if (appointment.status === 'COMPLETED') appointmentTotals.attended += 1;
      else if (appointment.status === 'CANCELLED') appointmentTotals.cancelled += 1;
      else if (appointment.status === 'MISSED') appointmentTotals.missed += 1;
      else appointmentTotals.scheduled += 1;
    }

    return {
      person: {
        id: person.id,
        displayName: person.displayName,
        dateOfBirth: person.dateOfBirth,
        gender: person.gender,
      },
      healthProfile: person.healthProfile
        ? {
            bloodGroup: person.healthProfile.bloodGroup,
            genotype: person.healthProfile.genotype,
            heightCm: person.healthProfile.heightCm,
            weightKg: person.healthProfile.weightKg,
            allergies: person.healthProfile.allergies,
            existingConditions: person.healthProfile.existingConditions,
            currentMedications: person.healthProfile.currentMedications,
            disabilities: person.healthProfile.disabilities,
            smokingStatus: person.healthProfile.smokingStatus,
            alcoholUse: person.healthProfile.alcoholUse,
          }
        : null,
      pregnancy: pregnancy
        ? {
            lmpDate: pregnancy.lmpDate,
            expectedDeliveryDate: pregnancy.expectedDeliveryDate,
            currentWeek: pregnancy.currentWeek,
            trimester: pregnancy.trimester,
          }
        : null,
      medications: medications.map((med) => ({
        name: med.name,
        dosage: med.dosage,
        frequency: med.frequency,
        startDate: med.startDate,
        endDate: med.endDate,
        instructions: med.instructions,
        planStatus: med.carePlan.status,
        doses: countsByPlan.get(med.carePlan.id) ?? emptyCounts(),
      })),
      doseTotals,
      appointments: appointments.map((appointment) => ({
        title: appointment.carePlan.title,
        startsAt: appointment.startsAt,
        durationMinutes: appointment.durationMinutes,
        status: appointment.status,
        clinician: appointment.clinician,
        specialty: appointment.specialty,
        location: appointment.location,
        reason: appointment.reason,
        notes: appointment.notes,
        cancellationReason: appointment.cancellationReason,
      })),
      appointmentTotals,
      symptoms,
      moods,
      period,
      generatedAt: new Date(),
      isEmpty:
        medications.length === 0 &&
        appointments.length === 0 &&
        symptoms.length === 0 &&
        moods.length === 0,
    };
  },

  /**
   * Record that a summary left the system.
   *
   * Written after the data is gathered and before a byte is streamed, so a
   * connection dropped mid-download still leaves the fact recorded. The
   * alternative — recording on success — would mean a reader who cancelled the
   * download after receiving half a health record left no trace at all.
   */
  async recordGeneration(
    userId: string,
    personId: string,
    period: ReportPeriod,
  ): Promise<void> {
    await reportsRepository.recordGeneration({
      personId,
      generatedByUserId: userId,
      periodStart: period.start,
      periodEnd: period.end,
    });

    log.info('Health summary generated', {
      userId,
      personId,
      from: period.start.toISOString(),
      to: period.end.toISOString(),
    });
  },

  /** Who has taken a copy of this Person's history out, and when. */
  async listGenerations(userId: string, requestedPersonId?: string) {
    const personId = await personAccess.resolveSubject(userId, requestedPersonId, 'read');
    return reportsRepository.listGenerations(personId);
  },

  // ── Asynchronous generation ───────────────────────────────

  /**
   * Accept a request for a summary. Renders nothing.
   *
   * Both gates are resolved here, in the same order and for the same reasons
   * as before: access first, so a caller with no relationship to a Person is
   * told that rather than invited to upgrade. Checking them now means an
   * unauthorised request is refused immediately instead of being queued and
   * failing out of sight — and the worker checks again anyway, because the
   * answer can change while the job waits.
   */
  async requestHealthSummary(
    userId: string,
    requestedPersonId: string | undefined,
    period: ReportPeriod,
  ) {
    const personId = await personAccess.resolveSubject(userId, requestedPersonId, 'read');

    const tier = await entitlementService.tierFor(userId);
    if (tier !== 'PREMIUM') {
      throw AppError.forbidden('Generating a health summary is a Premium feature.');
    }

    if (period.end < period.start) {
      throw AppError.badRequest('The end of the period must be after its start');
    }

    const generation = await reportsRepository.createPending({
      personId,
      generatedByUserId: userId,
      periodStart: period.start,
      periodEnd: period.end,
    });

    await reportsQueue.add(
      JOB_NAMES.GENERATE_HEALTH_SUMMARY,
      { reportGenerationId: generation.id } satisfies GenerateHealthSummaryPayload,
      { jobId: generation.id },
    );

    log.info('Health summary requested', {
      userId,
      personId,
      reportGenerationId: generation.id,
    });

    return generation;
  },

  /**
   * Where a request has got to.
   *
   * Access is re-resolved rather than compared against who asked: a caregiver
   * who can read the Person can see that a summary of that Person was taken,
   * which is the same visibility `listGenerations` already gives.
   */
  async generationStatus(userId: string, reportGenerationId: string) {
    const generation = await reportsRepository.generationById(reportGenerationId);
    if (!generation) throw AppError.notFound('Report not found');

    await personAccess.assertPersonAccess(userId, generation.personId, 'read');

    const { generatedByUserId: _byUser, storageKey: _key, ...view } = generation;
    return view;
  },

  /**
   * Authorise a download and hand back what the route needs to stream it.
   *
   * Every gate is checked again here, on every fetch. Being the account that
   * asked for the document earns nothing: membership can be revoked and
   * Premium can lapse between generating a summary and fetching it, and in
   * both cases the fetch must fail. This is the check a signed URL would have
   * skipped.
   */
  async prepareDownload(userId: string, reportGenerationId: string) {
    const generation = await reportsRepository.generationById(reportGenerationId);
    if (!generation) throw AppError.notFound('Report not found');

    await personAccess.assertPersonAccess(userId, generation.personId, 'read');

    const tier = await entitlementService.tierFor(userId);
    if (tier !== 'PREMIUM') {
      throw AppError.forbidden('Generating a health summary is a Premium feature.');
    }

    if (generation.status === 'FAILED') {
      throw AppError.badRequest(
        generation.failureReason ?? 'That summary could not be generated.',
      );
    }

    if (generation.status === 'PENDING' || generation.status === 'PROCESSING') {
      throw AppError.badRequest('That summary is still being prepared.');
    }

    // Expired, or expired-but-not-yet-swept. Both are gone as far as a reader
    // is concerned, and a sweep running late must not extend anyone's access.
    const storageKey = generation.storageKey;
    const expired =
      generation.status === 'EXPIRED' ||
      storageKey === null ||
      (generation.expiresAt !== null && generation.expiresAt <= new Date());

    if (expired || storageKey === null) {
      throw AppError.gone(
        'That summary has expired. Generating another one takes a moment.',
      );
    }

    // The row says READY but the file is not there — a restart cleared the
    // directory, or the disk was swept from under it. Correct the row so it
    // stops advertising something that cannot be served.
    const size = await fileSize(storageKey);
    if (size === null) {
      await reportsRepository.markExpired(generation.id);
      throw AppError.gone(
        'That summary has expired. Generating another one takes a moment.',
      );
    }

    const person = await reportsRepository.person(generation.personId);

    await reportsRepository.markDownloaded(generation.id);

    log.info('Health summary downloaded', {
      userId,
      personId: generation.personId,
      reportGenerationId: generation.id,
    });

    return {
      stream: openReadStream(storageKey),
      sizeBytes: size,
      filename: summaryFilename(person?.displayName ?? 'person', generation.periodEnd),
    };
  },

  /**
   * Render one accepted request. Called by the worker, never by a route.
   *
   * Returns false when another attempt already claimed the row, so the caller
   * can treat a replayed job as done rather than as a failure.
   */
  async renderPending(reportGenerationId: string): Promise<boolean> {
    const claimed = await reportsRepository.claimForRendering(reportGenerationId);
    if (!claimed) return false;

    const generation = await reportsRepository.generationById(reportGenerationId);
    if (!generation) throw new Error('Report generation row disappeared mid-render');

    // The account that asked may have been erased while the job waited, which
    // SET NULL allows. There is then nobody whose access can be re-resolved,
    // and rendering on behalf of no one is exactly what must not happen.
    if (!generation.generatedByUserId) {
      await reportsRepository.markFailed(
        reportGenerationId,
        'The account that requested this summary no longer exists.',
      );
      return true;
    }

    const storageKey = newStorageKey();

    try {
      // Re-resolves membership and entitlement. Access lost while the job sat
      // in the queue fails it here rather than producing a document nobody is
      // entitled to.
      const summary = await reportsService.buildHealthSummary(
        generation.generatedByUserId,
        generation.personId,
        { start: generation.periodStart, end: generation.periodEnd },
      );

      const stream = await openWriteStream(storageKey);

      await new Promise<void>((resolve, reject) => {
        stream.on('error', reject);
        stream.on('finish', () => resolve());
        renderHealthSummary(summary, stream);
      });

      const expiresAt = new Date(Date.now() + env.REPORT_TTL_MINUTES * 60_000);
      await reportsRepository.markReady(reportGenerationId, storageKey, expiresAt);

      log.info('Health summary rendered', {
        reportGenerationId,
        personId: generation.personId,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err: any) {
      // Half a health record on disk with no row pointing at it is the worst
      // outcome available here, so the file goes before the row is updated.
      await deleteFile(storageKey);
      await reportsRepository.markFailed(
        reportGenerationId,
        err?.message ?? 'The summary could not be generated.',
      );
      throw err;
    }

    return true;
  },

  /**
   * Delete documents whose time is up, and any file no row owns.
   *
   * The orphan pass is the one that matters for the promise this module makes.
   * A row is only updated after its file is complete, so a crash in between
   * leaves a health record on disk that no expiry covers. Nothing else would
   * ever remove it.
   */
  async sweepExpiredDocuments(): Promise<{ expired: number; orphans: number }> {
    const due = await reportsRepository.dueForExpiry(new Date());

    for (const row of due) {
      if (row.storageKey) await deleteFile(row.storageKey);
      await reportsRepository.markExpired(row.id);
    }

    const liveKeys = await reportsRepository.liveStorageKeys();
    const orphans = await orphanedFiles(liveKeys);
    for (const name of orphans) await deleteFile(name);

    if (due.length > 0 || orphans.length > 0) {
      log.info('Report documents swept', { expired: due.length, orphans: orphans.length });
    }

    return { expired: due.length, orphans: orphans.length };
  },
};

/**
 * The filename a reader sees. Derived from the Person and the period, so a
 * folder of these is sortable and tells the reader which is which.
 */
export const summaryFilename = (displayName: string, periodEnd: Date): string => {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `vitals-summary-${slug}-${periodEnd.toISOString().slice(0, 10)}.pdf`;
};
