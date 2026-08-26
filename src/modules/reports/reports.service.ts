import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { personAccess } from '@/modules/person/person.access';
import { entitlementService } from '@/modules/billing/entitlement.service';
import { reportsRepository, type ReportPeriod } from './reports.repository';

const log = createLogger('reports');

/**
 * Health summaries.
 *
 * ── Why this is not a background job ─────────────────────────────────────
 *
 * Project rule: long-running work goes to the BullMQ worker rather than the
 * request path. It does not apply here, and the reason is worth writing down
 * so this is not "fixed" later into something worse.
 *
 * That rule exists to keep slow work off the request path. Rendering one
 * Person's summary with PDFKit is a few dozen database rows laid out as text —
 * it is not slow, and there is no long-running work to move. Making it a job
 * would not remove work from the request; it would add a stored artifact, and
 * that artifact is the problem: a PDF holding a Person's entire health record,
 * duplicated outside the tables that own it and outside every access check
 * that guards them, sitting somewhere until someone remembers to delete it.
 *
 * So the document is streamed and nothing is kept. If a future summary really
 * does become slow — years of data, images, many Persons at once — the answer
 * is to stream it in pages, or to accept a job whose output is deleted on a
 * timer. It is not to quietly start storing health records.
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
};
