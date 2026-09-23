import request from 'supertest';
import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import { createUser, createMedicationPlan, authHeader } from './helpers/factories';

/**
 * /care/events — the first endpoint cut over to the authorization layer.
 *
 * Two sites: a list read, and the status update that was the only explicit
 * ownership check in the codebase. Both now resolve a subject and authorize
 * before any clinical query runs.
 */

const app = createApp();

async function grantAccess(
  personId: string,
  userId: string,
  role: 'OWNER' | 'CAREGIVER' | 'VIEWER',
  status: 'ACTIVE' | 'REVOKED' = 'ACTIVE',
) {
  return prisma.personMembership.create({
    data: { personId, userId, role, status, acceptedAt: new Date() },
  });
}

describe('GET /care/events', () => {
  it('returns only the caller’s own events by default', async () => {
    const alice = await createUser();
    const bob = await createUser();
    await createMedicationPlan(alice.id, 'Amlodipine');
    await createMedicationPlan(bob.id, 'Metformin');

    const res = await request(app).get('/api/v1/care/events').set(...authHeader(alice));

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('Amlodipine');
    expect(body).not.toContain('Metformin');
  });

  it('refuses a personId the caller has no relationship with', async () => {
    const alice = await createUser();
    const bob = await createUser();
    await createMedicationPlan(bob.id, 'Metformin');

    const res = await request(app)
      .get(`/api/v1/care/events?personId=${bob.personId}`)
      .set(...authHeader(alice));

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Metformin');
  });

  it('allows a granted caregiver to read the person they care for', async () => {
    const patient = await createUser();
    const carer = await createUser();
    await createMedicationPlan(patient.id, 'Amlodipine');
    await grantAccess(patient.personId, carer.id, 'CAREGIVER');

    const res = await request(app)
      .get(`/api/v1/care/events?personId=${patient.personId}`)
      .set(...authHeader(carer));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Amlodipine');
  });

  it('stops returning data the moment the grant is revoked', async () => {
    const patient = await createUser();
    const carer = await createUser();
    await createMedicationPlan(patient.id, 'Amlodipine');
    const membership = await grantAccess(patient.personId, carer.id, 'CAREGIVER');

    await request(app)
      .get(`/api/v1/care/events?personId=${patient.personId}`)
      .set(...authHeader(carer))
      .expect(200);

    await prisma.personMembership.update({
      where: { id: membership.id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });

    // Same token, no refresh. This is why memberships are not in the JWT.
    const after = await request(app)
      .get(`/api/v1/care/events?personId=${patient.personId}`)
      .set(...authHeader(carer));

    expect(after.status).toBe(403);
  });
});

describe('PATCH /care/events/:id/status', () => {
  it('refuses a stranger', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const { careEventId } = await createMedicationPlan(bob.id, 'Metformin');

    const res = await request(app)
      .patch(`/api/v1/care/events/${careEventId}/status`)
      .set(...authHeader(alice))
      .send({ status: 'DONE' });

    expect(res.status).toBe(403);

    const untouched = await prisma.careEvent.findUnique({ where: { id: careEventId } });
    expect(untouched?.status).toBe('PENDING');
  });

  it('lets a CAREGIVER mark a dose taken', async () => {
    const patient = await createUser();
    const carer = await createUser();
    const { careEventId } = await createMedicationPlan(patient.id);
    await grantAccess(patient.personId, carer.id, 'CAREGIVER');

    const res = await request(app)
      .patch(`/api/v1/care/events/${careEventId}/status`)
      .set(...authHeader(carer))
      .send({ status: 'DONE' });

    expect(res.status).toBe(200);

    const updated = await prisma.careEvent.findUnique({ where: { id: careEventId } });
    expect(updated?.status).toBe('DONE');
  });

  it('refuses a VIEWER — read does not imply write', async () => {
    const patient = await createUser();
    const viewer = await createUser();
    const { careEventId } = await createMedicationPlan(patient.id);
    await grantAccess(patient.personId, viewer.id, 'VIEWER');

    // The viewer can see it...
    await request(app)
      .get(`/api/v1/care/events?personId=${patient.personId}`)
      .set(...authHeader(viewer))
      .expect(200);

    // ...but cannot act on it.
    const res = await request(app)
      .patch(`/api/v1/care/events/${careEventId}/status`)
      .set(...authHeader(viewer))
      .send({ status: 'DONE' });

    expect(res.status).toBe(403);
    const untouched = await prisma.careEvent.findUnique({ where: { id: careEventId } });
    expect(untouched?.status).toBe('PENDING');
  });

  it('attributes a caregiver’s action to the caregiver, on the patient’s history', async () => {
    const patient = await createUser();
    const carer = await createUser();
    const { careEventId } = await createMedicationPlan(patient.id);
    await grantAccess(patient.personId, carer.id, 'CAREGIVER');

    await request(app)
      .patch(`/api/v1/care/events/${careEventId}/status`)
      .set(...authHeader(carer))
      .send({ status: 'DONE' })
      .expect(200);

    const entry = await prisma.activityLog.findFirstOrThrow({
      where: { type: 'CARE_EVENT_UPDATED' },
    });

    // Whose history: the patient. Who did it: the caregiver.
    expect(entry.personId).toBe(patient.personId);
    expect(entry.actorUserId).toBe(carer.id);
  });
});
