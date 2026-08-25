import request from 'supertest';
import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import { motherBabyService } from '@/modules/mother-baby/mother-baby.service';
import { createUser, createMedicationPlan, createMoodLog, authHeader } from './helpers/factories';

/**
 * The hybrid dashboard, the profile split, and the /persons surface.
 */

const app = createApp();

const isoDate = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function deliverBaby(motherId: string, name: string) {
  await motherBabyService.setupPregnancy(motherId, { lmpDate: isoDate(-280) } as any);
  await motherBabyService.recordDelivery(motherId, {
    deliveryDate: isoDate(0),
    babyName: name,
  });
  return prisma.person.findFirstOrThrow({ where: { displayName: name } });
}

describe('dashboard — clinical follows the person, account does not', () => {
  it('separates the two rather than interleaving them', async () => {
    const user = await createUser();
    await createMedicationPlan(user.id, 'Amlodipine');
    await createMoodLog(user.id, 'good');

    const res = await request(app).get('/api/v1/dashboard').set(...authHeader(user));

    expect(res.status).toBe(200);
    expect(res.body.data.subject).toMatchObject({ personId: user.personId, isSelf: true });
    expect(res.body.data.care).toHaveProperty('todayTasks');
    expect(res.body.data.care).toHaveProperty('journey');
    expect(res.body.data.account).toHaveProperty('usageSummary');

    // Quota is about the account, not a body: it must not sit inside `care`.
    expect(res.body.data.care).not.toHaveProperty('usageSummary');
  });

  it('switches the clinical half and leaves the account half alone', async () => {
    const mother = await createUser();
    const baby = await deliverBaby(mother.id, 'Ada');

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await prisma.dailyUsage.create({
      data: { userId: mother.id, date: today, symptomChecksUsed: 2 },
    });

    const own = await request(app).get('/api/v1/dashboard').set(...authHeader(mother));
    const babyView = await request(app)
      .get(`/api/v1/dashboard?personId=${baby.id}`)
      .set(...authHeader(mother));

    expect(own.body.data.subject.personId).toBe(mother.personId);
    expect(babyView.body.data.subject.personId).toBe(baby.id);
    expect(babyView.body.data.subject.isSelf).toBe(false);

    // The clinical half moved...
    expect(own.body.data.care.journey.pregnancies.total).toBe(1);
    expect(own.body.data.care.journey.vaccinations.plans).toBe(0);
    expect(babyView.body.data.care.journey.vaccinations.plans).toBe(1);
    expect(babyView.body.data.care.journey.pregnancies.total).toBe(0);

    // ...and the account half did not.
    expect(own.body.data.account.usageSummary.symptomChecksUsed).toBe(2);
    expect(babyView.body.data.account.usageSummary.symptomChecksUsed).toBe(2);
  });

  it('keeps the baby visible on the mother’s dashboard, named, not merged in', async () => {
    const mother = await createUser();
    const baby = await deliverBaby(mother.id, 'Ada');

    const res = await request(app).get('/api/v1/dashboard').set(...authHeader(mother));

    const entry = res.body.data.people.find((p: any) => p.personId === baby.id);
    expect(entry).toBeDefined();
    // The label can be honest because it names the Person and says how she
    // reaches them.
    expect(entry.displayName).toBe('Ada');
    expect(entry.relationship).toBe('managed');
    expect(entry.role).toBe('OWNER');
    expect(entry.upcomingTasks).toBeGreaterThan(0);

    // And the baby's vaccinations are not counted as the mother's own.
    expect(res.body.data.care.journey.vaccinations.plans).toBe(0);
  });

  it('refuses a person the caller cannot read', async () => {
    const alice = await createUser();
    const bob = await createUser();

    const res = await request(app)
      .get(`/api/v1/dashboard?personId=${bob.personId}`)
      .set(...authHeader(alice));

    expect(res.status).toBe(403);
  });
});

describe('profile split', () => {
  it('writes clinical fields to the Person, not to Profile', async () => {
    const user = await createUser();

    await request(app)
      .patch('/api/v1/users/profile')
      .set(...authHeader(user))
      .send({ timezone: 'Africa/Lagos', bloodGroup: 'O+', allergies: ['penicillin'] })
      .expect(200);

    // Account settings on Profile...
    const profile = await prisma.profile.findUniqueOrThrow({ where: { userId: user.id } });
    expect(profile.timezone).toBe('Africa/Lagos');
    // ...clinical on the Person.
    const health = await prisma.personHealthProfile.findUniqueOrThrow({
      where: { personId: user.personId },
    });
    expect(health.bloodGroup).toBe('O+');
    expect(health.allergies).toEqual(['penicillin']);

    // Profile keeps its clinical columns, unread, for the compatibility window.
    expect(profile.bloodGroup).toBeNull();
  });

  it('still returns clinical values on the old endpoint, sourced from the Person', async () => {
    const user = await createUser();
    await prisma.personHealthProfile.create({
      data: { personId: user.personId, bloodGroup: 'AB-', genotype: 'AA' },
    });

    const res = await request(app)
      .get('/api/v1/users/profile')
      .set(...authHeader(user));

    expect(res.status).toBe(200);
    expect(res.body.data.health.bloodGroup).toBe('AB-');
    // Deprecated mirror, so no client breaks during the window.
    expect(res.body.data.profile.bloodGroup).toBe('AB-');
  });

  it('serves a managed person’s health through the person endpoint', async () => {
    const mother = await createUser();
    const baby = await deliverBaby(mother.id, 'Ada');

    await request(app)
      .patch(`/api/v1/persons/${baby.id}/health`)
      .set(...authHeader(mother))
      .send({ bloodGroup: 'O-', allergies: ['none known'] })
      .expect(200);

    const res = await request(app)
      .get(`/api/v1/persons/${baby.id}/health`)
      .set(...authHeader(mother));

    expect(res.body.data.bloodGroup).toBe('O-');

    // The mother's own record is untouched — this was impossible before,
    // because Profile.userId was unique.
    const own = await request(app)
      .get(`/api/v1/persons/${mother.personId}/health`)
      .set(...authHeader(mother));
    expect(own.body.data.bloodGroup).toBeNull();
  });

  it('refuses health for a person the caller cannot read', async () => {
    const alice = await createUser();
    const bob = await createUser();

    await request(app)
      .get(`/api/v1/persons/${bob.personId}/health`)
      .set(...authHeader(alice))
      .expect(403);
  });
});

describe('/persons and the membership surface', () => {
  it('lists the caller’s people and enforces managedPersonLimit on create', async () => {
    const user = await createUser();

    const list = await request(app).get('/api/v1/persons').set(...authHeader(user));
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ personId: user.personId, isSelf: true });

    // Free tier is 0 managed Persons, and this path has no baby exemption.
    const refused = await request(app)
      .post('/api/v1/persons')
      .set(...authHeader(user))
      .send({ displayName: 'Grandma' });
    expect(refused.status).toBe(400);

    await prisma.user.update({
      where: { id: user.id },
      data: { managedPersonLimit: 1 },
    });

    const allowed = await request(app)
      .post('/api/v1/persons')
      .set(...authHeader(user))
      .send({ displayName: 'Grandma', dateOfBirth: '1955-03-02' });
    expect(allowed.status).toBe(201);
    expect(allowed.body.data.origin).toBe('MANAGED');
  });

  it('grants nothing until accepted, and enforces connectionLimit at accept', async () => {
    const owner = await createUser();
    const carer = await createUser();

    await request(app)
      .post(`/api/v1/persons/${owner.personId}/members`)
      .set(...authHeader(owner))
      .send({ email: carer.email, role: 'CAREGIVER' })
      .expect(201);

    // Invited is not access.
    await request(app)
      .get(`/api/v1/dashboard?personId=${owner.personId}`)
      .set(...authHeader(carer))
      .expect(403);

    // Free tier connects to nobody.
    const refused = await request(app)
      .post(`/api/v1/persons/${owner.personId}/members/accept`)
      .set(...authHeader(carer));
    expect(refused.status).toBe(400);

    await prisma.user.update({ where: { id: carer.id }, data: { connectionLimit: 1 } });

    await request(app)
      .post(`/api/v1/persons/${owner.personId}/members/accept`)
      .set(...authHeader(carer))
      .expect(200);

    await request(app)
      .get(`/api/v1/dashboard?personId=${owner.personId}`)
      .set(...authHeader(carer))
      .expect(200);
  });

  it('only an owner may invite, and only the invitee may accept', async () => {
    const owner = await createUser();
    const carer = await createUser();
    const stranger = await createUser();

    await prisma.personMembership.create({
      data: {
        personId: owner.personId,
        userId: carer.id,
        role: 'CAREGIVER',
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });

    // A caregiver cannot widen access on someone else's behalf.
    await request(app)
      .post(`/api/v1/persons/${owner.personId}/members`)
      .set(...authHeader(carer))
      .send({ email: stranger.email, role: 'VIEWER' })
      .expect(403);

    // And a stranger cannot accept an invitation that was never issued.
    await request(app)
      .post(`/api/v1/persons/${owner.personId}/members/accept`)
      .set(...authHeader(stranger))
      .expect(404);
  });

  it('revokes access immediately and records it rather than erasing it', async () => {
    const owner = await createUser();
    const carer = await createUser();
    await prisma.user.update({ where: { id: carer.id }, data: { connectionLimit: 1 } });

    await request(app)
      .post(`/api/v1/persons/${owner.personId}/members`)
      .set(...authHeader(owner))
      .send({ email: carer.email, role: 'CAREGIVER' })
      .expect(201);
    await request(app)
      .post(`/api/v1/persons/${owner.personId}/members/accept`)
      .set(...authHeader(carer))
      .expect(200);

    await request(app)
      .delete(`/api/v1/persons/${owner.personId}/members/${carer.id}`)
      .set(...authHeader(owner))
      .expect(200);

    // Same token, no refresh.
    await request(app)
      .get(`/api/v1/dashboard?personId=${owner.personId}`)
      .set(...authHeader(carer))
      .expect(403);

    const history = await request(app)
      .get(`/api/v1/persons/${owner.personId}/access-history`)
      .set(...authHeader(owner));

    const actions = history.body.data.map((e: any) => e.action);
    expect(actions).toContain('GRANTED');
    expect(actions).toContain('ACCEPTED');
    expect(actions).toContain('REVOKED');
  });

  it('refuses to revoke the only owner', async () => {
    const owner = await createUser();

    const res = await request(app)
      .delete(`/api/v1/persons/${owner.personId}/members/${owner.id}`)
      .set(...authHeader(owner));

    expect(res.status).toBe(409);
  });

  it('reports capacity, including the first-baby exemption', async () => {
    const mother = await createUser();
    await deliverBaby(mother.id, 'Ada');

    const res = await request(app).get('/api/v1/persons/capacity').set(...authHeader(mother));

    expect(res.body.data).toMatchObject({
      managedLimit: 0,
      managedUsed: 0,
      firstBabyExempt: true,
    });
  });
});
