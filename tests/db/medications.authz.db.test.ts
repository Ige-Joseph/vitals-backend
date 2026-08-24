import request from 'supertest';
import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import { createUser, createMedicationPlan, authHeader } from './helpers/factories';

/**
 * /medications — the second endpoint cut over.
 *
 * Its scoping runs through a relation (`carePlan: { personId }`), so a missing
 * filter here is invisible to a mocked client and invisible to any test with
 * only one user in it.
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

const isoDate = (offsetDays: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

const validPlan = {
  name: 'Amlodipine',
  dosage: '5mg',
  frequency: 'ONCE_DAILY',
  startDate: isoDate(1),
  durationDays: 3,
  customTimes: ['08:00'],
};

describe('reads are person-scoped', () => {
  it('lists only the caller’s own medications by default', async () => {
    const alice = await createUser();
    const bob = await createUser();
    await createMedicationPlan(alice.id, 'Amlodipine');
    await createMedicationPlan(bob.id, 'Metformin');

    const res = await request(app).get('/api/v1/medications').set(...authHeader(alice));

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('Amlodipine');
    expect(body).not.toContain('Metformin');
  });

  it('refuses a personId with no relationship', async () => {
    const alice = await createUser();
    const bob = await createUser();
    await createMedicationPlan(bob.id, 'Metformin');

    const res = await request(app)
      .get(`/api/v1/medications?personId=${bob.personId}`)
      .set(...authHeader(alice));

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Metformin');
  });

  it('does not expose a plan by id to a stranger who knows the id', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const { carePlanId } = await createMedicationPlan(bob.id, 'Metformin');

    const res = await request(app)
      .get(`/api/v1/medications/${carePlanId}`)
      .set(...authHeader(alice));

    // Alice's own subject scope simply does not contain Bob's plan.
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Metformin');
  });
});

describe('writes require write capability on the subject', () => {
  it('dual-writes the subject when a plan is created', async () => {
    const user = await createUser();

    const res = await request(app)
      .post('/api/v1/medications')
      .set(...authHeader(user))
      .send(validPlan);

    expect(res.status).toBe(201);

    const plan = await prisma.carePlan.findFirstOrThrow({ where: { userId: user.id } });
    expect(plan.personId).toBe(user.personId);
    expect(plan.userId).toBe(user.id);

    const entry = await prisma.activityLog.findFirstOrThrow({
      where: { type: 'MEDICATION_CREATED' },
    });
    expect(entry.personId).toBe(user.personId);
    expect(entry.actorUserId).toBe(user.id);
  });

  it('lets a CAREGIVER add a medication for the person they care for', async () => {
    const patient = await createUser();
    const carer = await createUser();
    await grant(patient.personId, carer.id, 'CAREGIVER');

    const res = await request(app)
      .post(`/api/v1/medications?personId=${patient.personId}`)
      .set(...authHeader(carer))
      .send(validPlan);

    expect(res.status).toBe(201);

    // Recorded against the patient, attributed to the carer.
    const plan = await prisma.carePlan.findFirstOrThrow({
      where: { personId: patient.personId },
    });
    expect(plan.userId).toBe(carer.id);
  });

  it('refuses a VIEWER', async () => {
    const patient = await createUser();
    const viewer = await createUser();
    await grant(patient.personId, viewer.id, 'VIEWER');

    const res = await request(app)
      .post(`/api/v1/medications?personId=${patient.personId}`)
      .set(...authHeader(viewer))
      .send(validPlan);

    expect(res.status).toBe(403);
    expect(await prisma.carePlan.count({ where: { personId: patient.personId } })).toBe(0);
  });

  it('refuses a stranger deleting someone else’s plan', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const { carePlanId } = await createMedicationPlan(bob.id, 'Metformin');

    const res = await request(app)
      .delete(`/api/v1/medications/${carePlanId}`)
      .set(...authHeader(alice));

    expect(res.status).toBe(404);

    const survived = await prisma.carePlan.findUnique({ where: { id: carePlanId } });
    expect(survived?.status).toBe('ACTIVE');
  });
});
