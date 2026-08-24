import { prisma } from '@/lib/prisma';
import type { PrismaTx } from '@/types/prisma';

export interface CapacityUsage {
  managedLimit: number;
  managedUsed: number;
  connectionLimit: number;
  connectionsUsed: number;
  /** Whether a first-baby exemption is currently being applied. */
  firstBabyExempt: boolean;
}

/**
 * Origins that represent a baby added through the mother-baby journey. The
 * earliest of these that an account owns does not consume a managed slot,
 * because the journey is core free functionality and the free tier is
 * managedPersonLimit = 0.
 */
const BABY_ORIGINS = ['DELIVERY', 'BABY_PROFILE'] as const;

export const personRepository = {
  /**
   * Managed capacity is derived, never stored.
   *
   * A managed slot is an ACTIVE OWNER membership over a Person that nobody has
   * claimed (`ownerUserId IS NULL`). A connected Person owns itself, so it is
   * counted on the other axis and can never consume a managed slot. Claiming
   * sets `ownerUserId` and the slot frees itself — no counter to decrement and
   * nothing that can drift.
   */
  async capacityFor(userId: string): Promise<CapacityUsage> {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { managedPersonLimit: true, connectionLimit: true },
    });

    const [managedUsed, connectionsUsed] = await Promise.all([
      prisma.personMembership.count({
        where: {
          userId,
          role: 'OWNER',
          status: 'ACTIVE',
          person: { ownerUserId: null, archivedAt: null },
        },
      }),
      prisma.personMembership.count({
        where: {
          userId,
          status: 'ACTIVE',
          person: {
            archivedAt: null,
            ownerUserId: { not: null },
            NOT: { ownerUserId: userId },
          },
        },
      }),
    ]);

    // Exempt exactly one baby — the earliest. Derived from provenance and
    // ordering rather than a stored flag, so it cannot drift. A second baby
    // (twins, another child) consumes capacity like any other dependent.
    const babyCount = await prisma.personMembership.count({
      where: {
        userId,
        role: 'OWNER',
        status: 'ACTIVE',
        person: {
          ownerUserId: null,
          archivedAt: null,
          origin: { in: [...BABY_ORIGINS] },
        },
      },
    });

    const firstBabyExempt = babyCount > 0;

    return {
      managedLimit: user.managedPersonLimit,
      managedUsed: firstBabyExempt ? managedUsed - 1 : managedUsed,
      connectionLimit: user.connectionLimit,
      connectionsUsed,
      firstBabyExempt,
    };
  },

  /** Whether this account already owns a baby Person that is still unclaimed. */
  async hasBabyPerson(userId: string): Promise<boolean> {
    const count = await prisma.personMembership.count({
      where: {
        userId,
        role: 'OWNER',
        status: 'ACTIVE',
        person: {
          ownerUserId: null,
          archivedAt: null,
          origin: { in: [...BABY_ORIGINS] },
        },
      },
    });
    return count > 0;
  },

  /**
   * Persons this account is the *only* active OWNER of, and which nobody has
   * claimed. These are the records that would be stranded if the account went
   * away, so they block both deactivation and erasure.
   */
  async soleOwnedUnclaimedPersons(userId: string) {
    const owned = await prisma.personMembership.findMany({
      where: {
        userId,
        role: 'OWNER',
        status: 'ACTIVE',
        person: { ownerUserId: null, archivedAt: null },
      },
      select: { personId: true, person: { select: { displayName: true } } },
    });

    if (owned.length === 0) return [];

    const personIds = owned.map((o) => o.personId);

    // Any other active OWNER means the record is not stranded.
    const alsoOwned = await prisma.personMembership.groupBy({
      by: ['personId'],
      where: {
        personId: { in: personIds },
        role: 'OWNER',
        status: 'ACTIVE',
        NOT: { userId },
      },
      _count: { personId: true },
    });

    const sharedIds = new Set(alsoOwned.map((a) => a.personId));

    return owned
      .filter((o) => !sharedIds.has(o.personId))
      .map((o) => ({ personId: o.personId, displayName: o.person.displayName }));
  },

  /**
   * Append to the consent ledger. Never updated, never deleted — a revocation
   * is a new row, not a mutation of the grant it revokes.
   */
  recordAccessEvent(
    data: {
      personId: string;
      subjectUserId?: string | null;
      actorUserId?: string | null;
      action:
        | 'GRANTED'
        | 'ACCEPTED'
        | 'CLAIMED'
        | 'REVOKED'
        | 'TRANSFERRED'
        | 'ARCHIVED'
        | 'ERASED';
      role?: 'OWNER' | 'CAREGIVER' | 'VIEWER' | null;
      basis: string;
      metadata?: Record<string, unknown>;
    },
    tx?: PrismaTx,
  ) {
    const client = tx ?? prisma;
    return client.personAccessEvent.create({
      data: {
        personId: data.personId,
        subjectUserId: data.subjectUserId ?? null,
        actorUserId: data.actorUserId ?? null,
        action: data.action,
        role: data.role ?? null,
        basis: data.basis,
        metadata: (data.metadata ?? {}) as any,
      },
    });
  },
};
