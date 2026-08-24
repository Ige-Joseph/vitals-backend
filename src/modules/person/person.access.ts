import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';

const log = createLogger('person-access');

/**
 * The authorization layer.
 *
 * Before this, authorization in this codebase was emergent: repositories
 * filtered on `where: { userId }` and that was safe only because the caller
 * and the subject were the same entity. Exactly one explicit ownership check
 * existed — `care.service.ts:37`, `if (event.carePlan.userId !== userId)
 * throw forbidden` — and this helper is that check generalised to the case
 * where caller and subject can differ.
 *
 * Two rules govern everything below:
 *
 *   1. Access comes from an ACTIVE membership. Not from owning the clinical
 *      row, not from having created it, and never from `createdByUserId`,
 *      which is provenance only.
 *   2. Memberships are looked up, never carried in the token. They change and
 *      tokens do not, so a revoked grant must stop working immediately rather
 *      than at the next refresh.
 */

export type Capability = 'read' | 'write' | 'manage';

/**
 * Coarse on purpose. A permission matrix is the thing that would make family
 * access feel complicated to the people using it.
 *
 *   VIEWER    — read only
 *   CAREGIVER — read, and act on care (mark a dose taken, log a symptom)
 *   OWNER     — the above, plus invite, revoke, transfer and archive
 */
const ROLE_CAPABILITIES: Record<string, Capability[]> = {
  OWNER: ['read', 'write', 'manage'],
  CAREGIVER: ['read', 'write'],
  VIEWER: ['read'],
};

export interface PersonAccess {
  personId: string;
  role: string;
  capabilities: Capability[];
}

export const personAccess = {
  /**
   * Throws unless `userId` may exercise `capability` over `personId`.
   *
   * Returns the resolved access so callers can branch without a second query.
   */
  async assertPersonAccess(
    userId: string,
    personId: string,
    capability: Capability,
  ): Promise<PersonAccess> {
    const membership = await prisma.personMembership.findUnique({
      where: { personId_userId: { personId, userId } },
      select: { role: true, status: true, person: { select: { archivedAt: true } } },
    });

    // No relationship at all. Deliberately the same error as a revoked one —
    // a caller must not be able to tell "this Person exists but you were
    // removed" from "no such Person".
    if (!membership || membership.status !== 'ACTIVE') {
      log.warn('Person access denied', {
        userId,
        personId,
        capability,
        reason: membership ? `membership ${membership.status}` : 'no membership',
      });
      throw AppError.forbidden('Access denied');
    }

    if (membership.person.archivedAt) {
      throw AppError.forbidden('This record has been archived');
    }

    const capabilities = ROLE_CAPABILITIES[membership.role] ?? [];

    if (!capabilities.includes(capability)) {
      log.warn('Person capability denied', {
        userId,
        personId,
        capability,
        role: membership.role,
      });
      throw AppError.forbidden(
        `Your access to this record does not allow this action`,
      );
    }

    return { personId, role: membership.role, capabilities };
  },

  /**
   * The Person an account acts on when it does not name one.
   *
   * Every account gets a self-Person at signup, so this is the identity case:
   * "my own health data". Endpoints that accept an explicit personId use that
   * instead, and always go through assertPersonAccess either way.
   */
  async resolveSelfPersonId(userId: string): Promise<string> {
    const person = await prisma.person.findFirst({
      where: { ownerUserId: userId, archivedAt: null },
      select: { id: true },
    });

    if (!person) {
      // Pre-separation accounts backfilled in phase B all have one. An account
      // without one is a bug, not a permission problem.
      throw AppError.internal('No health record is linked to this account');
    }

    return person.id;
  },

  /**
   * Resolve the subject for a request: an explicitly named Person if the
   * caller supplied one, otherwise their own.
   *
   * This is the single entry point endpoints use, so the authorization check
   * cannot be forgotten by taking the personId straight from the request.
   */
  async resolveSubject(
    userId: string,
    requestedPersonId: string | undefined,
    capability: Capability,
  ): Promise<string> {
    const personId = requestedPersonId ?? (await personAccess.resolveSelfPersonId(userId));
    await personAccess.assertPersonAccess(userId, personId, capability);
    return personId;
  },
};

export const { assertPersonAccess, resolveSelfPersonId, resolveSubject } = personAccess;
