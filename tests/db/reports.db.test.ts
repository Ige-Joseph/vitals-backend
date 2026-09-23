import request from 'supertest';

import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import { reportsService } from '@/modules/reports/reports.service';
import { appointmentsService } from '@/modules/appointments/appointments.service';
import { createUser, authHeader, type TestUser } from './helpers/factories';

/**
 * Health summaries, against real rows.
 *
 * Three things are worth proving and none of them is "a PDF came out".
 *
 * That the two gates are genuinely independent — membership decides whose
 * record, entitlement decides whether this account may export at all — and
 * that failing either one produces nothing.
 *
 * That the document contains what the user recorded and only that: counts of
 * doses as they were logged, and no model-generated text anywhere, which is
 * enforced at the query rather than filtered at the renderer.
 *
 * That a Person with almost nothing on file produces a document with those
 * sections absent, not a document full of headings with nothing underneath.
 */

const app = createApp();

const grant = (
  personId: string,
  userId: string,
  role: 'OWNER' | 'CAREGIVER' | 'VIEWER',
) =>
  prisma.personMembership.create({
    data: { personId, userId, role, status: 'ACTIVE', acceptedAt: new Date() },
  });

const premium = () => createUser({ planType: 'PREMIUM' });

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
const daysAhead = (days: number) => new Date(Date.now() + days * 86_400_000);

const period = { start: daysAgo(90), end: daysAhead(30) };

/** Pull the streamed PDF out of supertest as raw bytes. */
const downloadPdf = (user: TestUser, query = '') =>
  request(app)
    .get(`/api/v1/reports/health-summary${query}`)
    .set(...authHeader(user))
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });

/**
 * A Person with a real spread of history: a medication whose doses landed in
 * every recorded state, appointments across every outcome, symptoms and moods
 * that carry model output alongside what was actually written, and a health
 * profile.
 */
const populate = async (user: TestUser) => {
  const personId = user.personId;

  await prisma.personHealthProfile.create({
    data: {
      personId,
      bloodGroup: 'O+',
      genotype: 'AA',
      heightCm: 171,
      weightKg: 68.5,
      allergies: ['Penicillin', 'Peanuts'],
      existingConditions: ['Hypertension'],
      currentMedications: ['Amlodipine 5mg'],
      disabilities: [],
      smokingStatus: 'NEVER',
      alcoholUse: 'OCCASIONAL',
    },
  });

  const carePlan = await prisma.carePlan.create({
    data: {
      userId: user.id,
      personId,
      type: 'MEDICATION',
      title: 'Amlodipine — 5mg',
      status: 'ACTIVE',
      metadata: { frequency: 'ONCE_DAILY' },
      medication: {
        create: {
          name: 'Amlodipine',
          dosage: '5mg',
          frequency: 'ONCE_DAILY',
          startDate: daysAgo(30),
          endDate: daysAhead(10),
          instructions: 'Take in the morning',
        },
      },
    },
  });

  // Four taken, two skipped, three missed, one still scheduled.
  const doses: Array<[string, number]> = [
    ['DONE', 4],
    ['SKIPPED', 2],
    ['MISSED', 3],
    ['PENDING', 1],
  ];
  let offset = 1;
  for (const [status, count] of doses) {
    for (let i = 0; i < count; i += 1) {
      await prisma.careEvent.create({
        data: {
          carePlanId: carePlan.id,
          eventType: 'MEDICATION_DOSE',
          title: 'Amlodipine 5mg',
          scheduledFor: daysAgo(offset),
          status: status as never,
        },
      });
      offset += 1;
    }
  }

  // One of each appointment outcome.
  const attended = await appointmentsService.create(user.id, {
    title: 'Cardiology review',
    startsAt: daysAhead(2),
    durationMinutes: 45,
    clinician: 'Dr Adeyemi',
    specialty: 'Cardiology',
    location: 'LUTH',
    reason: 'Six-month review',
    notes: 'Ask about the rash',
  } as never);
  await appointmentsService.complete(user.id, attended.id);

  const calledOff = await appointmentsService.create(user.id, {
    title: 'Dental check',
    startsAt: daysAhead(4),
    durationMinutes: 30,
  } as never);
  await appointmentsService.cancel(user.id, calledOff.id, 'Clinic closed');

  await appointmentsService.create(user.id, {
    title: 'Physiotherapy',
    startsAt: daysAhead(9),
    durationMinutes: 60,
  } as never);

  // Symptoms and moods that carry model output. The point of writing it is to
  // prove it never comes back out.
  await prisma.symptomLog.create({
    data: {
      userId: user.id,
      personId,
      symptomsText: 'Headache behind the eyes since Tuesday',
      severity: 'MODERATE',
      aiResponse: {
        severity: 'moderate',
        summary: 'THIS IS MODEL OUTPUT AND MUST NOT APPEAR',
        guidance: 'THIS IS MODEL OUTPUT AND MUST NOT APPEAR',
      },
    },
  });

  await prisma.moodLog.create({
    data: {
      userId: user.id,
      personId,
      mood: 'Low',
      craving: 'Salt',
      insight: 'THIS IS MODEL OUTPUT AND MUST NOT APPEAR',
      loggedAt: daysAgo(3),
    },
  });

  await prisma.drugDetection.create({
    data: {
      userId: user.id,
      personId,
      imageUrl: 'https://example.test/not-a-real-image.jpg',
      detectedDrug: 'Ibuprofen',
      aiResponse: { drugName: 'Ibuprofen', commonUsage: 'MODEL OUTPUT' },
    },
  });

  return { carePlanId: carePlan.id, attendedId: attended.id };
};

describe('two gates, resolved independently', () => {
  it('refuses an account with no relationship to the Person', async () => {
    const subscriber = await premium();
    const stranger = await premium();
    await populate(subscriber);

    await expect(
      reportsService.buildHealthSummary(stranger.id, subscriber.personId, period),
    ).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });

    const res = await downloadPdf(stranger, `?personId=${subscriber.personId}`);
    expect(res.status).toBe(403);

    // Refused before anything was produced, so nothing was recorded either.
    expect(await prisma.reportGeneration.count()).toBe(0);
  });

  it('refuses a free account even for its own record', async () => {
    const free = await createUser();
    await populate(free);

    await expect(
      reportsService.buildHealthSummary(free.id, undefined, period),
    ).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });

    const res = await downloadPdf(free);
    expect(res.status).toBe(403);
    expect(await prisma.reportGeneration.count()).toBe(0);
  });

  it('refuses a Premium account reporting on a stranger, and a free OWNER on a dependent', async () => {
    // Premium is not a way past membership…
    const wealthy = await premium();
    const other = await createUser();
    await expect(
      reportsService.buildHealthSummary(wealthy.id, other.personId, period),
    ).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });

    // …and membership is not a way past entitlement.
    const carer = await createUser();
    const dependent = await createUser();
    await grant(dependent.personId, carer.id, 'OWNER');
    await expect(
      reportsService.buildHealthSummary(carer.id, dependent.personId, period),
    ).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
  });

  it('lets a Premium caregiver summarise a dependent', async () => {
    const carer = await premium();
    const dependent = await createUser();
    await grant(dependent.personId, carer.id, 'CAREGIVER');

    const summary = await reportsService.buildHealthSummary(
      carer.id,
      dependent.personId,
      period,
    );

    // The subject is the dependent, not the account that asked.
    expect(summary.person.id).toBe(dependent.personId);
  });
});

describe('the summary carries what was recorded, and nothing derived', () => {
  it('counts doses in the four recorded states and computes nothing else', async () => {
    const user = await premium();
    await populate(user);

    const summary = await reportsService.buildHealthSummary(user.id, undefined, period);

    expect(summary.doseTotals).toEqual({
      taken: 4,
      skipped: 2,
      missed: 3,
      scheduled: 1,
    });

    // Exactly four keys. Nothing that could be read as an adherence figure —
    // no percentage, rate, score, streak or trend has been added alongside.
    expect(Object.keys(summary.doseTotals).sort()).toEqual([
      'missed',
      'scheduled',
      'skipped',
      'taken',
    ]);

    const medication = summary.medications[0];
    expect(medication.name).toBe('Amlodipine');
    expect(medication.doses).toEqual({ taken: 4, skipped: 2, missed: 3, scheduled: 1 });
    expect(Object.keys(medication.doses)).toHaveLength(4);
  });

  it('counts appointments by outcome and keeps the user’s own notes', async () => {
    const user = await premium();
    await populate(user);

    const summary = await reportsService.buildHealthSummary(user.id, undefined, period);

    expect(summary.appointmentTotals).toEqual({
      attended: 1,
      cancelled: 1,
      missed: 0,
      scheduled: 1,
    });

    const attended = summary.appointments.find(a => a.title === 'Cardiology review');
    expect(attended?.clinician).toBe('Dr Adeyemi');
    // The user's own writing, which is exactly what someone wants in front of
    // them at a visit.
    expect(attended?.notes).toBe('Ask about the rash');

    const cancelled = summary.appointments.find(a => a.title === 'Dental check');
    expect(cancelled?.cancellationReason).toBe('Clinic closed');
  });

  it('carries no model-generated text of any kind', async () => {
    const user = await premium();
    await populate(user);

    const summary = await reportsService.buildHealthSummary(user.id, undefined, period);

    // What the user wrote survives…
    expect(summary.symptoms[0].symptomsText).toBe('Headache behind the eyes since Tuesday');
    expect(summary.symptoms[0].severity).toBe('MODERATE');
    expect(summary.moods[0].mood).toBe('Low');
    expect(summary.moods[0].craving).toBe('Salt');

    // …and nothing a model produced does. Excluded at the query, so there is
    // no path by which it could reach the renderer.
    expect(summary.symptoms[0]).not.toHaveProperty('aiResponse');
    expect(summary.moods[0]).not.toHaveProperty('insight');

    // Drug detections are absent entirely — the record is the model's output.
    expect(JSON.stringify(summary)).not.toContain('MODEL OUTPUT');
    expect(JSON.stringify(summary)).not.toContain('Ibuprofen');
  });

  it('includes the health profile as entered', async () => {
    const user = await premium();
    await populate(user);

    const summary = await reportsService.buildHealthSummary(user.id, undefined, period);

    expect(summary.healthProfile?.bloodGroup).toBe('O+');
    expect(summary.healthProfile?.allergies).toEqual(['Penicillin', 'Peanuts']);
    expect(summary.healthProfile?.existingConditions).toEqual(['Hypertension']);
  });

  it('leaves out what falls outside the period', async () => {
    const user = await premium();
    await populate(user);

    // A window that ends before anything in the fixture was recorded.
    const ancient = { start: daysAgo(400), end: daysAgo(300) };
    const summary = await reportsService.buildHealthSummary(user.id, undefined, ancient);

    expect(summary.doseTotals).toEqual({ taken: 0, skipped: 0, missed: 0, scheduled: 0 });
    expect(summary.appointments).toHaveLength(0);
    expect(summary.symptoms).toHaveLength(0);
    expect(summary.moods).toHaveLength(0);
  });
});

describe('a Person with sparse records', () => {
  it('reports empty sections as empty rather than as headings with nothing under them', async () => {
    const user = await premium();
    // Nothing populated at all: no profile, no medications, no appointments.

    const summary = await reportsService.buildHealthSummary(user.id, undefined, period);

    expect(summary.medications).toHaveLength(0);
    expect(summary.appointments).toHaveLength(0);
    expect(summary.symptoms).toHaveLength(0);
    expect(summary.moods).toHaveLength(0);
    expect(summary.healthProfile).toBeNull();
    expect(summary.pregnancy).toBeNull();

    // The one flag the renderer uses to say so once, instead of printing six
    // empty sections.
    expect(summary.isEmpty).toBe(true);
  });

  it('still produces a valid PDF for someone with almost nothing on file', async () => {
    const user = await premium();

    // One appointment and not another thing.
    await appointmentsService.create(user.id, {
      title: 'First GP visit',
      startsAt: daysAhead(5),
      durationMinutes: 30,
    } as never);

    const summary = await reportsService.buildHealthSummary(user.id, undefined, period);
    expect(summary.isEmpty).toBe(false);
    expect(summary.medications).toHaveLength(0);
    expect(summary.healthProfile).toBeNull();

    const res = await downloadPdf(user);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('the document is streamed, and only the fact of it is kept', () => {
  it('returns a PDF and records who took it, for which Person, over what period', async () => {
    const user = await premium();
    await populate(user);

    const from = daysAgo(60).toISOString().slice(0, 10);
    const to = daysAhead(20).toISOString().slice(0, 10);

    const res = await downloadPdf(user, `?from=${from}&to=${to}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('attachment');
    // A health record must not sit in a shared cache.
    expect(res.headers['cache-control']).toContain('no-store');

    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.body.length).toBeGreaterThan(1000);

    const generations = await prisma.reportGeneration.findMany();
    expect(generations).toHaveLength(1);
    expect(generations[0].personId).toBe(user.personId);
    expect(generations[0].generatedByUserId).toBe(user.id);
    expect(generations[0].kind).toBe('HEALTH_SUMMARY');
    expect(generations[0].periodStart.toISOString().slice(0, 10)).toBe(from);
    expect(generations[0].periodEnd.toISOString().slice(0, 10)).toBe(to);

    // The record has nowhere to put a file, which is the point: no path, no
    // blob, no url. Regenerating is how you get another copy.
    expect(Object.keys(generations[0])).toEqual(
      expect.not.arrayContaining(['filePath', 'fileUrl', 'storageKey', 'content']),
    );
  });

  it('shows a Person’s generation history to someone who may read that Person', async () => {
    const carer = await premium();
    const dependent = await createUser();
    await grant(dependent.personId, carer.id, 'CAREGIVER');

    await downloadPdf(carer, `?personId=${dependent.personId}`);

    const res = await request(app)
      .get(`/api/v1/reports/generations?personId=${dependent.personId}`)
      .set(...authHeader(carer));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].generatedByUserId).toBe(carer.id);

    // And not to someone who may not.
    const outsider = await premium();
    const refused = await request(app)
      .get(`/api/v1/reports/generations?personId=${dependent.personId}`)
      .set(...authHeader(outsider));
    expect(refused.status).toBe(403);
  });

  it('refuses a period that ends before it starts', async () => {
    const user = await premium();

    await expect(
      reportsService.buildHealthSummary(user.id, undefined, {
        start: daysAhead(10),
        end: daysAgo(10),
      }),
    ).rejects.toMatchObject({ errorCode: 'BAD_REQUEST' });
  });
});
