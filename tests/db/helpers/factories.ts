import jwt from 'jsonwebtoken';
import { prisma } from '@/lib/prisma';

/**
 * Real rows in a real database. Nothing here is mocked — the point of this
 * harness is that the `where` clauses under test run against actual data with
 * actual foreign keys.
 */

let counter = 0;

export interface TestUser {
  id: string;
  email: string;
  token: string;
  /** The account's own Person — every account has exactly one. */
  personId: string;
}

export async function createUser(
  overrides: Partial<{ email: string; planType: 'FREE' | 'PREMIUM'; role: 'USER' | 'ADMIN' }> = {},
): Promise<TestUser> {
  counter += 1;

  const email = overrides.email ?? `user${counter}@test.local`;

  const user = await prisma.user.create({
    data: {
      email,
      firstName: `User${counter}`,
      lastName: 'Test',
      // Not a real hash — no test here exercises password verification.
      passwordHash: 'not-a-real-hash',
      role: overrides.role ?? 'USER',
      planType: overrides.planType ?? 'FREE',
      emailVerified: true,
      profile: { create: { timezone: 'Africa/Lagos' } },
    },
  });

  // Mirror signup: every account gets a self-Person and an OWNER membership.
  // Without this the factory would produce accounts that cannot exist in
  // production, and person-scoped reads would have nothing to resolve.
  const person = await prisma.person.create({
    data: {
      displayName: `User${counter} Test`,
      ownerUserId: user.id,
      claimedAt: new Date(),
      createdByUserId: user.id,
      origin: 'SELF',
    },
  });

  await prisma.personMembership.create({
    data: {
      personId: person.id,
      userId: user.id,
      role: 'OWNER',
      status: 'ACTIVE',
      receivesNotifications: true,
      acceptedAt: new Date(),
    },
  });

  const token = jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      planType: user.planType,
      emailVerified: user.emailVerified,
    },
    process.env.JWT_ACCESS_SECRET as string,
    { expiresIn: '15m' },
  );

  return { id: user.id, email: user.email, token, personId: person.id };
}

export function authHeader(user: TestUser): [string, string] {
  return ['Authorization', `Bearer ${user.token}`];
}

/**
 * A medication care plan with one pending dose today, created directly rather
 * than through the API so scoping tests can set up another user's data without
 * depending on the endpoint they are testing.
 */
export async function createMedicationPlan(
  userId: string,
  name = 'Paracetamol',
): Promise<{ carePlanId: string; careEventId: string }> {
  const selfPersonId = (
    await prisma.person.findFirstOrThrow({ where: { ownerUserId: userId } })
  ).id;

  const carePlan = await prisma.carePlan.create({
    data: {
      userId,
      personId: selfPersonId,
      type: 'MEDICATION',
      title: `${name} — 500mg`,
      status: 'ACTIVE',
      metadata: { frequency: 'ONCE_DAILY' },
      medication: {
        create: {
          name,
          dosage: '500mg',
          frequency: 'ONCE_DAILY',
          startDate: new Date(),
          endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      },
    },
  });

  const scheduledFor = new Date();
  scheduledFor.setHours(scheduledFor.getHours() + 1, 0, 0, 0);

  const careEvent = await prisma.careEvent.create({
    data: {
      carePlanId: carePlan.id,
      eventType: 'MEDICATION_DOSE',
      title: `Take ${name}`,
      scheduledFor,
      status: 'PENDING',
    },
  });

  return { carePlanId: carePlan.id, careEventId: careEvent.id };
}

export async function createMoodLog(userId: string, mood: string): Promise<string> {
  const log = await prisma.moodLog.create({
    data: {
      userId,
      personId: (await prisma.person.findFirstOrThrow({ where: { ownerUserId: userId } })).id,
      mood,
      insight: 'test insight',
      loggedAt: new Date(),
    },
  });
  return log.id;
}
