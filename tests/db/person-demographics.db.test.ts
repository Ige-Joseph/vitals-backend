import request from 'supertest';
import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import { motherBabyService } from '@/modules/mother-baby/mother-baby.service';
import { createUser, authHeader } from './helpers/factories';

/**
 * Gender and date of birth describe a body, so they live on the Person.
 *
 * Profile keeps both columns during the compatibility window, exactly as it
 * keeps the clinical ones — retained, written by nothing, read by nothing.
 */

const app = createApp();

const isoDate = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

describe('/users/profile routes demographics to the Person', () => {
  it('writes gender and date of birth to the Person, not to Profile', async () => {
    const user = await createUser();

    await request(app)
      .patch('/api/v1/users/profile')
      .set(...authHeader(user))
      .send({ gender: 'FEMALE', dateOfBirth: '1996-04-11', city: 'Lagos' })
      .expect(200);

    const person = await prisma.person.findUniqueOrThrow({ where: { id: user.personId } });
    expect(person.gender).toBe('FEMALE');
    expect(person.dateOfBirth?.toISOString().slice(0, 10)).toBe('1996-04-11');

    const profile = await prisma.profile.findUniqueOrThrow({ where: { userId: user.id } });
    // Account settings still land on Profile...
    expect(profile.city).toBe('Lagos');
    // ...and its demographic columns are left alone.
    expect(profile.gender).toBeNull();
    expect(profile.dateOfBirth).toBeNull();
  });

  it('reads them back from the Person, including the deprecated mirror', async () => {
    const user = await createUser();
    await prisma.person.update({
      where: { id: user.personId },
      data: { gender: 'MALE', dateOfBirth: new Date('1987-01-02') },
    });

    const res = await request(app)
      .get('/api/v1/users/profile')
      .set(...authHeader(user));

    expect(res.status).toBe(200);
    expect(res.body.data.person).toMatchObject({ personId: user.personId, gender: 'MALE' });
    // Deprecated mirror inside `profile`, so no client breaks during the window.
    expect(res.body.data.profile.gender).toBe('MALE');
    expect(res.body.data.profile.dateOfBirth).toContain('1987-01-02');
  });

  it('does not read a stale value left on Profile', async () => {
    const user = await createUser();

    // Simulate a row written before the split: Profile has a value the Person
    // does not. Nothing should surface it.
    await prisma.profile.update({
      where: { userId: user.id },
      data: { gender: 'MALE', dateOfBirth: new Date('1970-01-01') },
    });

    const res = await request(app)
      .get('/api/v1/users/profile')
      .set(...authHeader(user));

    expect(res.body.data.person.gender).toBeNull();
    expect(res.body.data.profile.gender).toBeNull();
  });
});

describe('PATCH /persons/:id — demographics for anyone you may write to', () => {
  it('lets a mother correct her baby’s date of birth', async () => {
    const mother = await createUser();
    await motherBabyService.setupPregnancy(mother.id, { lmpDate: isoDate(-280) } as any);
    await motherBabyService.recordDelivery(mother.id, {
      deliveryDate: isoDate(-2),
      babyName: 'Ada',
    });

    const baby = await prisma.person.findFirstOrThrow({ where: { displayName: 'Ada' } });

    const res = await request(app)
      .patch(`/api/v1/persons/${baby.id}`)
      .set(...authHeader(mother))
      .send({ dateOfBirth: isoDate(-3), displayName: 'Ada Chioma' });

    expect(res.status).toBe(200);

    const updated = await prisma.person.findUniqueOrThrow({ where: { id: baby.id } });
    expect(updated.displayName).toBe('Ada Chioma');
    expect(updated.dateOfBirth?.toISOString().slice(0, 10)).toBe(isoDate(-3));
  });

  it('refuses a VIEWER', async () => {
    const owner = await createUser();
    const viewer = await createUser();
    await prisma.personMembership.create({
      data: {
        personId: owner.personId,
        userId: viewer.id,
        role: 'VIEWER',
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });

    await request(app)
      .patch(`/api/v1/persons/${owner.personId}`)
      .set(...authHeader(viewer))
      .send({ gender: 'MALE' })
      .expect(403);

    const untouched = await prisma.person.findUniqueOrThrow({ where: { id: owner.personId } });
    expect(untouched.gender).toBeNull();
  });

  it('refuses a stranger', async () => {
    const alice = await createUser();
    const bob = await createUser();

    await request(app)
      .patch(`/api/v1/persons/${bob.personId}`)
      .set(...authHeader(alice))
      .send({ displayName: 'Renamed' })
      .expect(403);
  });

  it('surfaces demographics on the person list, so the switcher can label rows', async () => {
    const user = await createUser();
    await prisma.person.update({
      where: { id: user.personId },
      data: { gender: 'FEMALE', dateOfBirth: new Date('1996-04-11') },
    });

    const res = await request(app).get('/api/v1/persons').set(...authHeader(user));

    expect(res.body.data[0]).toMatchObject({
      personId: user.personId,
      gender: 'FEMALE',
      isSelf: true,
    });
  });
});
