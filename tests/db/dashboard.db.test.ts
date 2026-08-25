import request from 'supertest';
import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import {
  createUser,
  createMedicationPlan,
  createMoodLog,
  authHeader,
} from './helpers/factories';

/**
 * Scoping shape under test: **fan-out**.
 *
 * One request, one `userId`, six queries across four models — care events
 * through `carePlan.userId`, mood by `userId`, daily usage by a compound
 * unique, and a `carePlan.groupBy` aggregate. Every one of them has to be
 * scoped independently; a single missed filter leaks one section of the
 * dashboard while the rest look correct.
 *
 * The mocked version of this suite returns `[]` from every model, so it proves
 * only that the handler assembles a response shape.
 */

const app = createApp();

describe('dashboard — fan-out scoping', () => {
  it('assembles the dashboard from real rows', async () => {
    const user = await createUser();
    await createMedicationPlan(user.id, 'Paracetamol');
    await createMoodLog(user.id, 'good');

    const res = await request(app)
      .get('/api/v1/dashboard')
      .set(...authHeader(user));

    expect(res.status).toBe(200);
    // Clinical and account halves are deliberately separate: they answer
    // different questions, and only the clinical half follows the person.
    expect(res.body.data.care).toHaveProperty('todayTasks');
    expect(res.body.data.care).toHaveProperty('upcomingReminders');
    expect(res.body.data.care).toHaveProperty('recentActivity');
    expect(res.body.data.care).toHaveProperty('latestMoodInsight');
    expect(res.body.data.account).toHaveProperty('usageSummary');

    // The care event really exists and really reaches the response, through
    // whichever bucket the scheduler placed it in.
    const surfaced = JSON.stringify([
      res.body.data.care.todayTasks,
      res.body.data.care.upcomingReminders,
    ]);
    expect(surfaced).toContain('Paracetamol');
  });

  it('never surfaces another user’s events, mood or counts', async () => {
    const alice = await createUser();
    const bob = await createUser();

    await createMedicationPlan(alice.id, 'Amlodipine');
    await createMoodLog(alice.id, 'low');

    await createMedicationPlan(bob.id, 'Metformin');
    await createMoodLog(bob.id, 'very_good');

    // A pregnancy plan for Bob only — exercises the groupBy aggregate, which
    // is the query most likely to be written without a user filter.
    await prisma.carePlan.create({
      data: {
        userId: bob.id,
        type: 'PREGNANCY',
        title: 'Pregnancy journey',
        status: 'ACTIVE',
      },
    });

    const res = await request(app)
      .get('/api/v1/dashboard')
      .set(...authHeader(alice));

    expect(res.status).toBe(200);

    const body = JSON.stringify(res.body);
    expect(body).toContain('Amlodipine');
    expect(body).not.toContain('Metformin');
    expect(body).not.toContain(bob.id);

    // Bob's pregnancy must not be counted in Alice's journey.
    expect(res.body.data.care.journey.pregnancies.total).toBe(0);
  });

  it('reports usage from the caller’s own quota row', async () => {
    const alice = await createUser();
    const bob = await createUser();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    await prisma.dailyUsage.create({
      data: { userId: bob.id, date: today, symptomChecksUsed: 3 },
    });

    const res = await request(app)
      .get('/api/v1/dashboard')
      .set(...authHeader(alice));

    expect(res.status).toBe(200);
    // Alice has no usage row at all; Bob's must not be picked up. The compound
    // unique (userId, date) is the only thing separating them.
    expect(res.body.data.account.usageSummary.symptomChecksUsed).toBe(0);
    expect(res.body.data.account.usageSummary.drugDetectionsUsed).toBe(0);
  });
});
