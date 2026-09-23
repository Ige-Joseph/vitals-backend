import { prisma } from '@/lib/prisma';
import { motherBabyService } from '@/modules/mother-baby/mother-baby.service';
import { personRepository } from '@/modules/person/person.repository';
import { personAccess } from '@/modules/person/person.access';
import { createUser } from './helpers/factories';

/**
 * A baby is a Person.
 *
 * recordDelivery no longer creates only a care plan — it creates a human. The
 * mother's pregnancy records stay on her Person; everything describing the
 * baby's health, the vaccination plan included, belongs to the baby's.
 */

const isoDate = (offsetDays: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

/** A pregnancy far enough along that delivery is plausible. */
async function startPregnancy(userId: string) {
  return motherBabyService.setupPregnancy(userId, {
    lmpDate: isoDate(-280),
  } as any);
}

describe('delivery creates a baby Person', () => {
  it('scopes the vaccination plan to the baby, not the mother', async () => {
    const mother = await createUser();
    await startPregnancy(mother.id);

    await motherBabyService.recordDelivery(mother.id, {
      deliveryDate: isoDate(0),
      babyName: 'Ada',
    });

    const baby = await prisma.person.findFirstOrThrow({
      where: { displayName: 'Ada' },
    });

    // The baby is a managed Person: nobody has claimed it, and it may never be.
    expect(baby.ownerUserId).toBeNull();
    expect(baby.origin).toBe('DELIVERY');
    expect(baby.createdByUserId).toBe(mother.id);

    const vaccinationPlan = await prisma.carePlan.findFirstOrThrow({
      where: { type: 'VACCINATION' },
    });
    expect(vaccinationPlan.personId).toBe(baby.id);
    expect(vaccinationPlan.personId).not.toBe(mother.personId);

    // ...and the vaccination events hang off it, so they reach the baby
    // transitively without a column of their own.
    const events = await prisma.careEvent.count({
      where: { carePlanId: vaccinationPlan.id },
    });
    expect(events).toBeGreaterThan(0);

    // The mother's pregnancy plan keeps her as its subject.
    const pregnancyPlan = await prisma.carePlan.findFirstOrThrow({
      where: { type: 'PREGNANCY' },
    });
    expect(pregnancyPlan.personId).toBe(mother.personId);
  });

  it('gives the mother OWNER access to the baby, recorded in the ledger', async () => {
    const mother = await createUser();
    await startPregnancy(mother.id);
    await motherBabyService.recordDelivery(mother.id, {
      deliveryDate: isoDate(0),
      babyName: 'Ada',
    });

    const baby = await prisma.person.findFirstOrThrow({ where: { displayName: 'Ada' } });

    await expect(
      personAccess.assertPersonAccess(mother.id, baby.id, 'manage'),
    ).resolves.toMatchObject({ role: 'OWNER' });

    const ledger = await prisma.personAccessEvent.findMany({
      where: { personId: baby.id },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ action: 'GRANTED', basis: 'delivery' });
  });

  it('keeps the baby unreachable to anyone else', async () => {
    const mother = await createUser();
    const stranger = await createUser();
    await startPregnancy(mother.id);
    await motherBabyService.recordDelivery(mother.id, {
      deliveryDate: isoDate(0),
      babyName: 'Ada',
    });

    const baby = await prisma.person.findFirstOrThrow({ where: { displayName: 'Ada' } });

    await expect(
      personAccess.assertPersonAccess(stranger.id, baby.id, 'read'),
    ).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
  });
});

describe('the first baby is free, later ones are not', () => {
  it('creates the first baby at managedPersonLimit = 0', async () => {
    const mother = await createUser();
    expect((await personRepository.capacityFor(mother.id)).managedLimit).toBe(0);

    await startPregnancy(mother.id);
    await expect(
      motherBabyService.recordDelivery(mother.id, {
        deliveryDate: isoDate(0),
        babyName: 'Ada',
      }),
    ).resolves.toBeTruthy();

    // The exemption shows as zero consumed, not as a raised limit.
    const capacity = await personRepository.capacityFor(mother.id);
    expect(capacity.firstBabyExempt).toBe(true);
    expect(capacity.managedUsed).toBe(0);
    expect(capacity.managedLimit).toBe(0);
  });

  it('refuses a second baby on the free tier', async () => {
    const mother = await createUser();
    await startPregnancy(mother.id);
    await motherBabyService.recordDelivery(mother.id, {
      deliveryDate: isoDate(0),
      babyName: 'Ada',
    });

    // A second child, added post-birth. Consumes capacity like any dependent.
    await expect(
      motherBabyService.createStandaloneBabyProfile(mother.id, {
        deliveryDate: isoDate(0),
        babyName: 'Chidi',
      }),
    ).rejects.toMatchObject({ errorCode: 'BAD_REQUEST' });

    expect(await prisma.person.count({ where: { displayName: 'Chidi' } })).toBe(0);
  });

  it('allows a second baby once capacity is granted', async () => {
    const mother = await createUser();
    await startPregnancy(mother.id);
    await motherBabyService.recordDelivery(mother.id, {
      deliveryDate: isoDate(0),
      babyName: 'Ada',
    });

    await prisma.user.update({
      where: { id: mother.id },
      data: { managedPersonLimit: 1 },
    });

    await expect(
      motherBabyService.createStandaloneBabyProfile(mother.id, {
        deliveryDate: isoDate(0),
        babyName: 'Chidi',
      }),
    ).resolves.toBeTruthy();

    const capacity = await personRepository.capacityFor(mother.id);
    // Two babies, one exempt: one slot consumed against a limit of one.
    expect(capacity.managedUsed).toBe(1);
    expect(capacity.managedLimit).toBe(1);

    const babies = await prisma.person.findMany({
      where: { origin: { in: ['DELIVERY', 'BABY_PROFILE'] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(babies.map((b) => b.displayName)).toEqual(['Ada', 'Chidi']);

    // Each baby has its own vaccination plan, scoped to itself.
    for (const baby of babies) {
      const plan = await prisma.carePlan.findFirstOrThrow({
        where: { personId: baby.id, type: 'VACCINATION' },
      });
      expect(plan.personId).toBe(baby.id);
    }
  });

  it('does not let a downgrade take an existing baby away', async () => {
    const mother = await createUser();
    await prisma.user.update({
      where: { id: mother.id },
      data: { managedPersonLimit: 1 },
    });

    await startPregnancy(mother.id);
    await motherBabyService.recordDelivery(mother.id, {
      deliveryDate: isoDate(0),
      babyName: 'Ada',
    });
    await motherBabyService.createStandaloneBabyProfile(mother.id, {
      deliveryDate: isoDate(0),
      babyName: 'Chidi',
    });

    // Downgrade below what is already held.
    await prisma.user.update({
      where: { id: mother.id },
      data: { managedPersonLimit: 0 },
    });

    const babies = await prisma.person.findMany({
      where: { origin: { in: ['DELIVERY', 'BABY_PROFILE'] } },
    });
    expect(babies).toHaveLength(2);

    // Both remain fully accessible — the ceiling is on new only, and health
    // data must never go read-only on a billing event.
    for (const baby of babies) {
      await expect(
        personAccess.assertPersonAccess(mother.id, baby.id, 'write'),
      ).resolves.toBeTruthy();
    }
  });
});
