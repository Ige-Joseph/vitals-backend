import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';

import { authenticate } from '@/middleware/auth.middleware';
import { AuthenticatedRequest } from '@/types/express';
import { ok, created, validationError } from '@/lib/response';
import { personMembershipService } from './person.membership.service';
import { personInvitationService } from './person.invitation.service';
import { personClaimService } from './person.claim.service';
import { personHealthService } from './person.health.service';
import { personRepository } from './person.repository';
import { personService } from './person.service';

const router = Router();

router.use(authenticate);

const createPersonSchema = z.object({
  displayName: z.string().min(1, 'A name is required').max(120),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
  gender: z.enum(['MALE', 'FEMALE', 'NON_BINARY', 'PREFER_NOT_TO_SAY']).optional(),
});

const inviteSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  role: z.enum(['CAREGIVER', 'VIEWER']),
});

const healthSchema = z.object({
  bloodGroup: z.string().max(10).nullable().optional(),
  genotype: z.string().max(10).nullable().optional(),
  heightCm: z.number().positive().nullable().optional(),
  weightKg: z.number().positive().nullable().optional(),
  allergies: z.array(z.string()).optional(),
  existingConditions: z.array(z.string()).optional(),
  currentMedications: z.array(z.string()).optional(),
  disabilities: z.array(z.string()).optional(),
  smokingStatus: z.string().max(50).nullable().optional(),
  alcoholUse: z.string().max(50).nullable().optional(),
});

const demographicsSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .nullable()
    .optional(),
  gender: z
    .enum(['MALE', 'FEMALE', 'NON_BINARY', 'PREFER_NOT_TO_SAY'])
    .nullable()
    .optional(),
});

const transferSchema = z.object({
  toUserId: z.string().min(1),
});

const invitationSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  role: z.enum(['CAREGIVER', 'VIEWER']),
  /**
   * "This record is about the person I am inviting." Set by the inviter, and
   * false unless they say otherwise.
   *
   * It has to be the inviter's assertion rather than something the invitee
   * decides at acceptance. If any invitee could claim any unclaimed record
   * they were shown, inviting an aunt to look at a baby's vaccination
   * schedule would be enough for her to take ownership of it and revoke the
   * parent — a lockout with no path back. The invitee still chooses whether
   * to act on it; this only makes the offer exist.
   */
  claimable: z.boolean().optional(),
});

const regrantSchema = z.object({
  grants: z
    .array(
      z.object({
        userId: z.string().min(1),
        role: z.enum(['CAREGIVER', 'VIEWER']),
      }),
    )
    .max(20),
});

/** Everyone this account can see — the person switcher's source. */
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const people = await personMembershipService.listForAccount(req.user!.sub);
    return ok(res, people, 'People retrieved');
  } catch (err) {
    next(err);
  }
});

/** Current entitlement, so a client can show why an action is unavailable. */
router.get('/capacity', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const capacity = await personRepository.capacityFor(req.user!.sub);
    return ok(res, capacity, 'Capacity retrieved');
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = createPersonSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

    const person = await personMembershipService.createManagedPerson(
      req.user!.sub,
      parsed.data,
    );
    return created(res, person, 'Person created');
  } catch (err) {
    next(err);
  }
});

router.get('/:personId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const person = await personMembershipService.get(req.user!.sub, String(req.params.personId));
    return ok(res, person, 'Person retrieved');
  } catch (err) {
    next(err);
  }
});

/** Demographics: name, date of birth, gender. Attributes of a body. */
router.patch('/:personId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = demographicsSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

    const person = await personMembershipService.updateDemographics(
      req.user!.sub,
      String(req.params.personId),
      parsed.data,
    );
    return ok(res, person, 'Person updated');
  } catch (err) {
    next(err);
  }
});

// ─── Clinical attributes ────────────────────────────────────────────────
// The half of the old Profile that describes a body rather than an account.

router.get(
  '/:personId/health',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const health = await personHealthService.get(req.user!.sub, String(req.params.personId));
      return ok(res, health, 'Health profile retrieved');
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  '/:personId/health',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = healthSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

      const health = await personHealthService.update(
        req.user!.sub,
        parsed.data,
        String(req.params.personId),
      );
      return ok(res, health, 'Health profile updated');
    } catch (err) {
      next(err);
    }
  },
);

// ─── Membership ─────────────────────────────────────────────────────────

router.get(
  '/:personId/members',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const members = await personMembershipService.listMembers(
        req.user!.sub,
        String(req.params.personId),
      );
      return ok(res, members, 'Members retrieved');
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/:personId/members',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = inviteSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

      const membership = await personMembershipService.invite(
        req.user!.sub,
        String(req.params.personId),
        parsed.data,
      );
      return created(res, membership, 'Invitation sent');
    } catch (err) {
      next(err);
    }
  },
);

/** Only the invited account can accept — consent is given, not assigned. */
router.post(
  '/:personId/members/accept',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const membership = await personMembershipService.accept(
        req.user!.sub,
        String(req.params.personId),
      );
      return ok(res, membership, 'Invitation accepted');
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  '/:personId/members/:targetUserId',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const membership = await personMembershipService.revoke(
        req.user!.sub,
        String(req.params.personId),
        String(req.params.targetUserId),
      );
      return ok(res, membership, 'Access revoked');
    } catch (err) {
      next(err);
    }
  },
);

/** Hand a managed record to another account. Bypasses their ceiling. */
router.post(
  '/:personId/transfer',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = transferSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

      const result = await personService.transferOwnership({
        personId: String(req.params.personId),
        fromUserId: req.user!.sub,
        toUserId: parsed.data.toUserId,
        actorUserId: req.user!.sub,
      });
      return ok(res, result, 'Ownership transferred');
    } catch (err) {
      next(err);
    }
  },
);

/** The consent ledger: who was granted what, by whom, and when. */
router.get(
  '/:personId/access-history',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const history = await personMembershipService.accessHistory(
        req.user!.sub,
        String(req.params.personId),
      );
      return ok(res, history, 'Access history retrieved');
    } catch (err) {
      next(err);
    }
  },
);

// ─── Invitations ────────────────────────────────────────────────────────
// The inviter's side. The invitee's side is mounted at /invitations, because
// answering an invitation happens before there is any access to check.

/**
 * Offer access by email, whether or not that address has an account.
 *
 * `POST /persons/:personId/members` remains and is unchanged — it still
 * answers 404 for an address with no account. This route is the one that
 * carries a token, an expiry and the claimable flag.
 */
router.post(
  '/:personId/invitations',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = invitationSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

      const { invitation } = await personInvitationService.invite(
        req.user!.sub,
        String(req.params.personId),
        parsed.data,
      );

      // Never the token. It goes to the address, and only to the address —
      // returning it here would let an owner accept on the invitee's behalf.
      return created(
        res,
        {
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          claimable: invitation.claimable,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
        },
        'Invitation sent',
      );
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/:personId/invitations',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const invitations = await personInvitationService.listForPerson(
        req.user!.sub,
        String(req.params.personId),
      );
      return ok(res, invitations, 'Invitations retrieved');
    } catch (err) {
      next(err);
    }
  },
);

/** Withdraw an offer that has not been answered. */
router.delete(
  '/:personId/invitations/:invitationId',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await personInvitationService.revokeInvitation(
        req.user!.sub,
        String(req.params.personId),
        String(req.params.invitationId),
      );
      return ok(res, result, 'Invitation withdrawn');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * The second half of a claim: keep the people who were managing the record.
 *
 * A claim revokes them, because once the record's subject owns it anyone
 * else's access is the subject's decision. This is that decision — one call,
 * made right after the claim, and bounded to the accounts the claim removed.
 */
router.post(
  '/:personId/claim-regrant',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = regrantSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

      const result = await personClaimService.regrantAfterClaim(
        req.user!.sub,
        String(req.params.personId),
        parsed.data.grants,
      );
      return ok(res, result, 'Access restored');
    } catch (err) {
      next(err);
    }
  },
);

export default router;
