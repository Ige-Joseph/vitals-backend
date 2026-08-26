import PDFDocument from 'pdfkit';

import type { HealthSummary } from './reports.service';

/**
 * The document.
 *
 * Rendered with PDFKit rather than a headless browser: this is a summary of
 * rows, not a web page, and shipping Chromium into the worker image to lay out
 * a list of medications would be a large dependency for a small job.
 *
 * ── What this file will not print ────────────────────────────────────────
 *
 * No percentage, score, rating, trend, streak or chart appears anywhere below,
 * and none should be added. Doses are shown as the four recorded counts beside
 * the period they were counted over. "42 of 56" invites a reader to compute an
 * adherence figure; the figure itself would be an assessment, and Vitals does
 * not assess — it organises what someone wrote down.
 *
 * No model-generated text appears either. Symptom AI guidance, mood insights
 * and drug detections are excluded at the query, not filtered here, so there
 * is no path by which they can reach this renderer.
 */

const INK = '#1a1c1e';
const MUTED = '#5a6068';
const RULE = '#d7dbe0';
const ACCENT = '#005bbf';

const PAGE_MARGIN = 54;

/**
 * dd Mmm yyyy — unambiguous in a document that may be read anywhere.
 *
 * Rendered in UTC, deliberately. Every value this formats is a *calendar date*
 * rather than a moment — a date of birth, a course's start and end, an LMP, the
 * bounds of the reported period — and all of them reach the database through
 * `new Date('YYYY-MM-DD')`, which is midnight UTC. Formatting those in the
 * server's local zone would print the day before on any server behind UTC, and
 * a date of birth off by one on a medical document is not a cosmetic fault.
 *
 * Instants use `dayTime` below, which is left in the server's zone on purpose.
 */
const day = (value: Date | string | null | undefined): string => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

const dayTime = (value: Date | string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${day(date)}, ${date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
};

/**
 * Age in whole years.
 *
 * Read in UTC for the same reason `day` prints in it: the stored value is
 * midnight UTC, and reading its parts locally would put the birthday on the
 * wrong date and tip the age over a day early or late.
 */
const years = (dob: Date | null): string | null => {
  if (!dob) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const month = now.getUTCMonth() - dob.getUTCMonth();
  if (month < 0 || (month === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age >= 0 && age < 150 ? `${age}` : null;
};

type Doc = PDFKit.PDFDocument;

const heading = (doc: Doc, text: string) => {
  if (doc.y > doc.page.height - PAGE_MARGIN - 90) doc.addPage();

  doc.moveDown(1);
  doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(11).text(text.toUpperCase(), {
    characterSpacing: 0.6,
  });
  doc.moveDown(0.3);

  const y = doc.y;
  doc
    .strokeColor(RULE)
    .lineWidth(0.8)
    .moveTo(PAGE_MARGIN, y)
    .lineTo(doc.page.width - PAGE_MARGIN, y)
    .stroke();

  doc.moveDown(0.6);
};

/** label: value, on one line, skipped entirely when there is no value. */
const field = (doc: Doc, label: string, value: string | null | undefined) => {
  if (value === null || value === undefined || value === '' || value === '—') return;

  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(MUTED).text(`${label}  `, {
    continued: true,
  });
  doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(value);
  doc.moveDown(0.15);
};

const bullet = (doc: Doc, text: string) => {
  if (doc.y > doc.page.height - PAGE_MARGIN - 40) doc.addPage();
  doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(`•  ${text}`, {
    indent: 4,
    lineGap: 1.5,
  });
};

const list = (doc: Doc, label: string, values: string[]) => {
  if (values.length === 0) return;
  field(doc, label, values.join(', '));
};

/**
 * Render a summary to the stream it is given.
 *
 * Writes straight into the response: nothing is buffered to disk, and nothing
 * survives the request. `doc.end()` is what finishes the HTTP response.
 */
export const renderHealthSummary = (
  summary: HealthSummary,
  stream: NodeJS.WritableStream,
): void => {
  const doc = new PDFDocument({
    size: 'A4',
    margin: PAGE_MARGIN,
    info: {
      Title: `Vitals summary — ${summary.person.displayName}`,
      Author: 'Vitals',
      Subject: 'A summary of information recorded in Vitals',
    },
  });

  doc.pipe(stream);

  // ── Masthead ───────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text('Health summary');
  doc.moveDown(0.15);
  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor(MUTED)
    .text(
      'A summary of information recorded in Vitals. It is not a medical record, ' +
        'and contains no diagnosis, assessment or advice.',
      { width: doc.page.width - PAGE_MARGIN * 2 },
    );

  doc.moveDown(0.9);

  doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(summary.person.displayName);
  doc.moveDown(0.3);

  const age = years(summary.person.dateOfBirth);
  field(doc, 'Date of birth', summary.person.dateOfBirth ? day(summary.person.dateOfBirth) : null);
  field(doc, 'Age', age);
  field(doc, 'Gender', summary.person.gender ?? null);
  field(doc, 'Period covered', `${day(summary.period.start)} to ${day(summary.period.end)}`);
  field(doc, 'Generated', dayTime(summary.generatedAt));

  // ── Health profile ─────────────────────────────────────────────────────
  const profile = summary.healthProfile;
  const hasProfile =
    profile &&
    (profile.bloodGroup ||
      profile.genotype ||
      profile.heightCm ||
      profile.weightKg ||
      profile.smokingStatus ||
      profile.alcoholUse ||
      profile.allergies.length > 0 ||
      profile.existingConditions.length > 0 ||
      profile.currentMedications.length > 0 ||
      profile.disabilities.length > 0);

  if (hasProfile && profile) {
    heading(doc, 'Health profile');
    field(doc, 'Blood group', profile.bloodGroup);
    field(doc, 'Genotype', profile.genotype);
    field(doc, 'Height', profile.heightCm ? `${profile.heightCm} cm` : null);
    field(doc, 'Weight', profile.weightKg ? `${profile.weightKg} kg` : null);
    field(doc, 'Smoking', profile.smokingStatus);
    field(doc, 'Alcohol', profile.alcoholUse);
    list(doc, 'Allergies', profile.allergies);
    list(doc, 'Existing conditions', profile.existingConditions);
    list(doc, 'Current medications', profile.currentMedications);
    list(doc, 'Disabilities', profile.disabilities);
  }

  // ── Pregnancy ──────────────────────────────────────────────────────────
  if (summary.pregnancy) {
    heading(doc, 'Pregnancy');
    field(doc, 'Last menstrual period', day(summary.pregnancy.lmpDate));
    field(doc, 'Expected delivery', day(summary.pregnancy.expectedDeliveryDate));
    field(doc, 'Current week', String(summary.pregnancy.currentWeek));
    field(doc, 'Trimester', String(summary.pregnancy.trimester));
  }

  // ── Medications ────────────────────────────────────────────────────────
  if (summary.medications.length > 0) {
    heading(doc, 'Medications');

    for (const med of summary.medications) {
      if (doc.y > doc.page.height - PAGE_MARGIN - 110) doc.addPage();

      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(`${med.name} — ${med.dosage}`);
      doc.moveDown(0.15);

      field(doc, 'Frequency', med.frequency);
      field(
        doc,
        'Dates',
        `${day(med.startDate)} to ${med.endDate ? day(med.endDate) : 'ongoing'}`,
      );
      field(doc, 'Status', med.planStatus);
      field(doc, 'Instructions', med.instructions);

      // Recorded outcomes for this medication, over the stated period. Four
      // counts, no fifth derived number.
      field(
        doc,
        'Doses recorded',
        `taken ${med.doses.taken} · skipped ${med.doses.skipped} · ` +
          `missed ${med.doses.missed} · still scheduled ${med.doses.scheduled}`,
      );

      doc.moveDown(0.45);
    }

    const total = summary.doseTotals;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(MUTED).text('All medications  ', {
      continued: true,
    });
    doc
      .font('Helvetica')
      .fillColor(INK)
      .text(
        `taken ${total.taken} · skipped ${total.skipped} · missed ${total.missed} · ` +
          `still scheduled ${total.scheduled}`,
      );
    doc.moveDown(0.2);
    doc
      .font('Helvetica-Oblique')
      .fontSize(8.5)
      .fillColor(MUTED)
      .text(
        `Counts of doses recorded between ${day(summary.period.start)} and ${day(
          summary.period.end,
        )}.`,
      );
  }

  // ── Appointments ───────────────────────────────────────────────────────
  if (summary.appointments.length > 0) {
    heading(doc, 'Appointments');

    for (const appt of summary.appointments) {
      if (doc.y > doc.page.height - PAGE_MARGIN - 90) doc.addPage();

      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(appt.title);
      doc.moveDown(0.15);

      field(doc, 'When', `${dayTime(appt.startsAt)} · ${appt.durationMinutes} min`);
      field(doc, 'Status', appt.status);
      field(doc, 'Clinician', appt.clinician);
      field(doc, 'Specialty', appt.specialty);
      field(doc, 'Location', appt.location);
      field(doc, 'Reason', appt.reason);
      field(doc, 'Notes', appt.notes);
      field(doc, 'Cancellation reason', appt.cancellationReason);

      doc.moveDown(0.45);
    }

    const counts = summary.appointmentTotals;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(MUTED).text('Appointments  ', {
      continued: true,
    });
    doc
      .font('Helvetica')
      .fillColor(INK)
      .text(
        `attended ${counts.attended} · cancelled ${counts.cancelled} · ` +
          `missed ${counts.missed} · still scheduled ${counts.scheduled}`,
      );
  }

  // ── Symptoms ───────────────────────────────────────────────────────────
  if (summary.symptoms.length > 0) {
    heading(doc, 'Symptoms recorded');
    for (const entry of summary.symptoms) {
      const severity = entry.severity ? ` (${entry.severity})` : '';
      bullet(doc, `${day(entry.createdAt)} — ${entry.symptomsText}${severity}`);
    }
  }

  // ── Mood ───────────────────────────────────────────────────────────────
  if (summary.moods.length > 0) {
    heading(doc, 'Mood recorded');
    for (const entry of summary.moods) {
      const parts = [entry.mood, entry.craving ? `craving: ${entry.craving}` : null]
        .filter(Boolean)
        .join(' · ');
      bullet(doc, `${day(entry.loggedAt)} — ${parts}`);
    }
  }

  // ── Nothing at all ─────────────────────────────────────────────────────
  if (summary.isEmpty) {
    heading(doc, 'Nothing recorded');
    doc
      .font('Helvetica')
      .fontSize(9.5)
      .fillColor(MUTED)
      .text(
        'No medications, appointments, symptoms or mood entries were recorded ' +
          'for this period.',
      );
  }

  // ── Footer ─────────────────────────────────────────────────────────────
  doc.moveDown(1.5);
  const y = doc.y;
  doc
    .strokeColor(RULE)
    .lineWidth(0.8)
    .moveTo(PAGE_MARGIN, y)
    .lineTo(doc.page.width - PAGE_MARGIN, y)
    .stroke();
  doc.moveDown(0.5);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(MUTED)
    .text(
      'Produced by Vitals from information entered by the user. Vitals does not ' +
        'diagnose, treat or advise, and nothing here is a clinical judgement.',
      { width: doc.page.width - PAGE_MARGIN * 2 },
    );

  doc.end();
};
