import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';

import { authenticate } from '@/middleware/auth.middleware';
import { AuthenticatedRequest } from '@/types/express';
import { ok, created, validationError } from '@/lib/response';
import { personMembershipService } from './person.membership.service';
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

export default router;
