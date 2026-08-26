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
/**
 * @swagger
 * /persons:
 *   get:
 *     tags: [Persons]
 *     summary: Every Person this account can see
 *     description: |
 *       Account-scoped, not person-scoped: it lists the memberships this account
 *       holds, so it needs no `personId` and resolves no subject.
 *
 *       `isSelf` marks the account's own record; `isClaimed` distinguishes a
 *       **managed** Person (a dependent with no account of their own) from a
 *       **connected** one (an adult who has claimed their record).
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The caller's Persons
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           personId: { type: string, format: uuid }
 *                           displayName: { type: string }
 *                           dateOfBirth: { type: string, format: date, nullable: true }
 *                           gender: { type: string, nullable: true }
 *                           origin:
 *                             type: string
 *                             enum: [SELF, DELIVERY, BABY_PROFILE, MANAGED]
 *                           role: { type: string, enum: [OWNER, CAREGIVER, VIEWER] }
 *                           isSelf: { type: boolean }
 *                           isClaimed: { type: boolean }
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const people = await personMembershipService.listForAccount(req.user!.sub);
    return ok(res, people, 'People retrieved');
  } catch (err) {
    next(err);
  }
});

/** Current entitlement, so a client can show why an action is unavailable. */
/**
 * @swagger
 * /persons/capacity:
 *   get:
 *     tags: [Persons]
 *     summary: How many Persons this account may hold
 *     description: |
 *       Account-scoped. Two independent axes — managed dependents and connected
 *       relationships — both resolved from what the account is paying for.
 *
 *       Limits are a **ceiling on new only**, never continuous: an account that
 *       falls below its limit after a downgrade keeps every Person it already
 *       has. Health data never becomes read-only on a billing event.
 *
 *       The earliest baby added through the Mother & Baby journey is exempt from
 *       the managed count.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Limits and usage on both axes
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         managedLimit: { type: integer }
 *                         managedUsed: { type: integer }
 *                         connectionLimit: { type: integer }
 *                         connectionsUsed: { type: integer }
 *                         firstBabyExempt: { type: boolean }
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/capacity', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const capacity = await personRepository.capacityFor(req.user!.sub);
    return ok(res, capacity, 'Capacity retrieved');
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /persons:
 *   post:
 *     tags: [Persons]
 *     summary: Add a dependent whose record this account will manage
 *     description: |
 *       Creates an unclaimed Person and an OWNER membership for the caller.
 *       Gated on the account's **managed-Person capacity**, checked before
 *       anything is written.
 *
 *       The record has no `ownerUserId`: it belongs to nobody yet. If the person
 *       it is about later gets their own account, they can claim it — see
 *       `POST /persons/{personId}/invitations` with `claimable: true`.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [displayName]
 *             properties:
 *               displayName: { type: string, example: Grandma Ngozi }
 *               dateOfBirth: { type: string, format: date }
 *               gender:
 *                 type: string
 *                 enum: [MALE, FEMALE, NON_BINARY, PREFER_NOT_TO_SAY]
 *     responses:
 *       201:
 *         description: Person created, with the caller as OWNER
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiResponse'
 *       400:
 *         description: Validation failed, or the managed-Person ceiling has been reached
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

/**
 * @swagger
 * /persons/{personId}:
 *   get:
 *     tags: [Persons]
 *     summary: One Person's demographics
 *     description: |
 *       **Access:** resolved through membership, not ownership of the row.
 *       The caller must hold an ACTIVE `PersonMembership` on this Person
 *       granting **`read`** — `OWNER`, `CAREGIVER` or `VIEWER`. Memberships are looked up on every
 *       request, never carried in the token, so a revoked grant stops working
 *       immediately rather than at the next refresh.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: personId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: The Person, with isSelf
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiResponse'
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: No such capability on this Person, or no relationship with them at all
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: No such Person, or none this caller can see
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/:personId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const person = await personMembershipService.get(req.user!.sub, String(req.params.personId));
    return ok(res, person, 'Person retrieved');
  } catch (err) {
    next(err);
  }
});

/** Demographics: name, date of birth, gender. Attributes of a body. */
/**
 * @swagger
 * /persons/{personId}:
 *   patch:
 *     tags: [Persons]
 *     summary: Correct a Person's demographics
 *     description: |
 *       **Access:** resolved through membership, not ownership of the row.
 *       The caller must hold an ACTIVE `PersonMembership` on this Person
 *       granting **`write`** — `OWNER` or `CAREGIVER`. Memberships are looked up on every
 *       request, never carried in the token, so a revoked grant stops working
 *       immediately rather than at the next refresh.
 *
 *       These describe a body, so they live on the Person rather than on the
 *       account's Profile. A caregiver correcting a dependent's date of birth is
 *       ordinary care; a VIEWER must not.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: personId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               displayName: { type: string }
 *               dateOfBirth: { type: string, format: date, nullable: true }
 *               gender: { type: string, nullable: true }
 *     responses:
 *       200:
 *         description: Updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiResponse'
 *       400:
 *         description: Validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: No such capability on this Person, or no relationship with them at all
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: No such Person, or none this caller can see
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

/**
 * @swagger
 * /persons/{personId}/health:
 *   get:
 *     tags: [Persons]
 *     summary: A Person's health profile
 *     description: |
 *       **Access:** resolved through membership, not ownership of the row.
 *       The caller must hold an ACTIVE `PersonMembership` on this Person
 *       granting **`read`** — `OWNER`, `CAREGIVER` or `VIEWER`. Memberships are looked up on every
 *       request, never carried in the token, so a revoked grant stops working
 *       immediately rather than at the next refresh.
 *
 *       Blood group, genotype, height, weight, allergies, conditions, current
 *       medications, disabilities, smoking and alcohol. Created lazily, so a
 *       Person who has never had one returns nulls rather than a 404.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: personId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: The health profile
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiResponse'
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: No such capability on this Person, or no relationship with them at all
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: No such Person, or none this caller can see
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

/**
 * @swagger
 * /persons/{personId}/health:
 *   patch:
 *     tags: [Persons]
 *     summary: Update a Person's health profile
 *     description: |
 *       **Access:** resolved through membership, not ownership of the row.
 *       The caller must hold an ACTIVE `PersonMembership` on this Person
 *       granting **`write`** — `OWNER` or `CAREGIVER`. Memberships are looked up on every
 *       request, never carried in the token, so a revoked grant stops working
 *       immediately rather than at the next refresh.
 *
 *       Upserts: a request carrying nothing creates a row of nulls, whose
 *       existence proves only that this endpoint was called.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: personId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               bloodGroup: { type: string, nullable: true }
 *               genotype: { type: string, nullable: true }
 *               heightCm: { type: number, nullable: true }
 *               weightKg: { type: number, nullable: true }
 *               allergies: { type: array, items: { type: string } }
 *               existingConditions: { type: array, items: { type: string } }
 *               currentMedications: { type: array, items: { type: string } }
 *               disabilities: { type: array, items: { type: string } }
 *               smokingStatus: { type: string, nullable: true }
 *               alcoholUse: { type: string, nullable: true }
 *     responses:
 *       200:
 *         description: Updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiResponse'
 *       400:
 *         description: Validation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: No such capability on this Person, or no relationship with them at all
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: No such Person, or none this caller can see
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

/**
 * @swagger
 * /persons/{personId}/members:
 *   get:
 *     tags: [Persons]
 *     summary: Who has access to this record
 *     description: |
 *       **Access:** resolved through membership, not ownership of the row.
 *       The caller must hold an ACTIVE `PersonMembership` on this Person
 *       granting **`read`** — `OWNER`, `CAREGIVER` or `VIEWER`. Memberships are looked up on every
 *       request, never carried in the token, so a revoked grant stops working
 *       immediately rather than at the next refresh.
 *
 *       Anyone who can read the record can see who else can — a person whose
 *       data is being shared is entitled to know with whom.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: personId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Members and their roles
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiResponse'
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: No such capability on this Person, or no relationship with them at all
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: No such Person, or none this caller can see
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

/**
 * @swagger
 * /persons/{personId}/members:
 *   post:
 *     tags: [Persons]
 *     summary: Invite an existing account to this record
 *     description: |
 *       **Access:** resolved through membership, not ownership of the row.
 *       The caller must hold an ACTIVE `PersonMembership` on this Person
 *       granting **`manage`** — `OWNER` only. Memberships are looked up on every
 *       request, never carried in the token, so a revoked grant stops working
 *       immediately rather than at the next refresh.
 *
 *       **Pre-existing surface, kept to its old contract**: an address with no
 *       Vitals account behind it is a 404 here. `POST /persons/{personId}/invitations`
 *       is the surface that can address somebody who has not signed up, and it
 *       carries the token, the expiry and the claimable flag.
 *
 *       The invitation grants nothing until accepted. Capacity is checked at
 *       acceptance, on the **accepting** account, where the membership becomes
 *       ACTIVE.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: personId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, role]
 *             properties:
 *               email: { type: string, format: email }
 *               role: { type: string, enum: [CAREGIVER, VIEWER] }
 *     responses:
 *       200:
 *         description: Invitation created; membership is INVITED until accepted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiResponse'
 *       400:
 *         description: Validation failed, or the caller already has access
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Not an OWNER of this Person
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: No active Vitals account with that address
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: That account already has access
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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
/**
 * @swagger
 * /persons/{personId}/members/accept:
 *   post:
 *     tags: [Persons]
 *     summary: Accept an invitation to this record
 *     description: |
 *       **Access:** none required — this is how access begins. The caller must
 *       hold an `INVITED` membership on this Person; anything else is a 404.
 *       Consent is given by the recipient and never assigned to them.
 *
 *       Capacity is checked here, on the accepting account, because this is
 *       where the membership becomes ACTIVE.
 *
 *       Also settles the underlying invitation, if the membership came from one.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: personId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Membership is now ACTIVE
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiResponse'
 *       400:
 *         description: The connection ceiling has been reached
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: No invitation to this record for this account
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

/**
 * @swagger
 * /persons/{personId}/members/{targetUserId}:
 *   delete:
 *     tags: [Persons]
 *     summary: End someone's access, or your own
 *     description: |
 *       **Access depends on whose membership it is.**
 *
 *       Removing *someone else* requires **`manage`** — `OWNER` only.
 *
 *       Removing *your own* requires no capability at all: nobody should need
 *       the owner's permission to stop holding their health data. A `VIEWER` can
 *       always walk away.
 *
 *       The last OWNER cannot be removed by either route — handoff is the path,
 *       or the record would be stranded with nobody able to act on it.
 *
 *       **Unlinking removes access only.** It never deletes an account and never
 *       deletes health data.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: personId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: targetUserId
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: The account losing access. The caller's own id is a self-revoke.
 *     responses:
 *       200:
 *         description: Access ended
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiResponse'
 *       400:
 *         description: That account is the last OWNER — transfer ownership instead
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Not an OWNER, and not removing your own access
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: No such membership
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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
/**
 * @swagger
 * /persons/{personId}/transfer:
 *   post:
 *     tags: [Persons]
 *     summary: Hand a managed record to another account
 *     description: |
 *       **Access:** resolved through membership, not ownership of the row.
 *       The caller must hold an ACTIVE `PersonMembership` on this Person
 *       granting **`manage`** — `OWNER` only. Memberships are looked up on every
 *       request, never carried in the token, so a revoked grant stops working
 *       immediately rather than at the next refresh.
 *
 *       For an **unclaimed** record only. A record that already belongs to the
 *       person it is about is not the caller's to hand anywhere.
 *
 *       **Receiving a handoff bypasses the recipient's capacity ceiling.** A
 *       transfer is not a new acquisition, and capacity must never be the reason
 *       a dependent has nowhere to go.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: personId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [toUserId]
 *             properties:
 *               toUserId: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Ownership moved; recorded in the consent ledger
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiResponse'
 *       400:
 *         description: Same account, or the record already belongs to its subject
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Not an OWNER of this Person
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: No such Person, or none this caller can see
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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
/**
 * @swagger
 * /persons/{personId}/access-history:
 *   get:
 *     tags: [Persons]
 *     summary: The consent ledger for this record
 *     description: |
 *       **Access:** resolved through membership, not ownership of the row.
 *       The caller must hold an ACTIVE `PersonMembership` on this Person
 *       granting **`read`** — `OWNER`, `CAREGIVER` or `VIEWER`. Memberships are looked up on every
 *       request, never carried in the token, so a revoked grant stops working
 *       immediately rather than at the next refresh.
 *
 *       Who was granted what, by whom, when, and its current state. Append-only:
 *       a revocation is a new row, never a mutation of the grant it revokes, and
 *       nothing here is ever deleted.
 *
 *       This is **not** `ActivityLog`, which is a user-facing feed. It exists
 *       because Nigeria's Data Protection Act applies to sharing health data.
 *
 *       A `CLAIM_REFUSED` row records that somebody was offered their own record
 *       and could not take it. **The reason is deliberately absent** — everyone
 *       with read access can see this ledger, the inviter included, and why a
 *       claim was not possible is a fact about the invitee's own record.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: personId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Access events, newest first
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           action:
 *                             type: string
 *                             enum: [GRANTED, ACCEPTED, CLAIMED, REVOKED, LEFT, TRANSFERRED, ARCHIVED, ERASED, CLAIM_REFUSED]
 *                           role: { type: string, nullable: true }
 *                           basis: { type: string }
 *                           occurredAt: { type: string, format: date-time }
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: No such capability on this Person, or no relationship with them at all
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: No such Person, or none this caller can see
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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
/**
 * @swagger
 * /persons/{personId}/invitations:
 *   post:
 *     tags: [Persons]
 *     summary: Offer access to this record, by email
 *     description: |
 *       **Access:** resolved through membership, not ownership of the row.
 *       The caller must hold an ACTIVE `PersonMembership` on this Person
 *       granting **`manage`** — `OWNER` only. Memberships are looked up on every
 *       request, never carried in the token, so a revoked grant stops working
 *       immediately rather than at the next refresh.
 *
 *       Unlike `POST /persons/{personId}/members`, the address **need not
 *       belong to an account**. The case that dominates is somebody who has
 *       never used Vitals arriving from a link, so the offer outlives the
 *       absence of an account. Where an account does exist, an `INVITED`
 *       membership is created alongside it exactly as before.
 *
 *       Re-inviting the same address supersedes the live offer rather than
 *       accumulating: a partial unique index permits one PENDING offer per
 *       address per record, and the superseded row stays as history.
 *
 *       `claimable` asserts that this record is *about* the person being
 *       invited, which is what makes taking ownership available at acceptance.
 *       It is the inviter's to assert and nobody else's — without it, anyone
 *       invited to look at a baby's record could take ownership and lock the
 *       parent out. It cannot be set on a record that already belongs to its
 *       subject.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: personId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, role]
 *             properties:
 *               email: { type: string, format: email }
 *               role: { type: string, enum: [CAREGIVER, VIEWER] }
 *               claimable:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       201:
 *         description: Offer created and the email queued
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         id: { type: string, format: uuid }
 *                         email: { type: string, format: email }
 *                         role: { type: string }
 *                         claimable: { type: boolean }
 *                         status: { type: string, enum: [PENDING] }
 *                         expiresAt: { type: string, format: date-time }
 *       400:
 *         description: Validation failed, or the caller invited themselves
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Not an OWNER of this Person
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: That account already has access, or the record already belongs to its subject
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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

/**
 * @swagger
 * /persons/{personId}/invitations:
 *   get:
 *     tags: [Persons]
 *     summary: Offers made on this record
 *     description: |
 *       **Access:** resolved through membership, not ownership of the row.
 *       The caller must hold an ACTIVE `PersonMembership` on this Person
 *       granting **`read`** — `OWNER`, `CAREGIVER` or `VIEWER`. Memberships are looked up on every
 *       request, never carried in the token, so a revoked grant stops working
 *       immediately rather than at the next refresh.
 *
 *       Live and settled, newest first. The token is never returned — it exists
 *       only in the email.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: personId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Offers on this record
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: string, format: uuid }
 *                           email: { type: string, format: email }
 *                           role: { type: string }
 *                           claimable: { type: boolean }
 *                           status:
 *                             type: string
 *                             enum: [PENDING, ACCEPTED, DECLINED, REVOKED]
 *                           expiresAt: { type: string, format: date-time }
 *                           acceptedAt: { type: string, format: date-time, nullable: true }
 *                           respondedAt: { type: string, format: date-time, nullable: true }
 *                           createdAt: { type: string, format: date-time }
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: No such capability on this Person, or no relationship with them at all
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: No such Person, or none this caller can see
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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
/**
 * @swagger
 * /persons/{personId}/invitations/{invitationId}:
 *   delete:
 *     tags: [Persons]
 *     summary: Withdraw an offer nobody has answered
 *     description: |
 *       **Access:** resolved through membership, not ownership of the row.
 *       The caller must hold an ACTIVE `PersonMembership` on this Person
 *       granting **`manage`** — `OWNER` only. Memberships are looked up on every
 *       request, never carried in the token, so a revoked grant stops working
 *       immediately rather than at the next refresh.
 *
 *       The link stops working immediately. Any `INVITED` membership created
 *       alongside the offer goes with it — it never granted anything, so nothing
 *       is being taken away and there is nothing to record in a ledger of
 *       access.
 *
 *       Only a PENDING offer can be withdrawn; a settled one is history.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: personId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: invitationId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Withdrawn
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiResponse'
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Not an OWNER of this Person
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: No pending invitation to withdraw
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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
/**
 * @swagger
 * /persons/{personId}/claim-regrant:
 *   post:
 *     tags: [Persons]
 *     summary: Restore access a claim removed
 *     description: |
 *       **Access:** the caller must be the account this record now belongs to —
 *       `Person.ownerUserId`. Not a membership capability: this is the subject
 *       of the record deciding who may keep looking at it.
 *
 *       The second of the two decisions a claim involves. Taking ownership
 *       revoked everyone who was managing the record; this offers it back.
 *
 *       **Bounded to exactly the accounts that claim revoked.** The candidate
 *       list is read out of the ledger, not off the request, so this cannot be
 *       used to grant access to an arbitrary account —
 *       `POST /persons/{personId}/invitations` is that path, and it is an offer
 *       the recipient has to accept.
 *
 *       Two consequences of that bound. The grant lands `ACTIVE` rather than
 *       `INVITED`, because the recipient held this access a moment ago and is
 *       being left where they were, not handed something new. And it bypasses
 *       the recipient's connection ceiling, because the relationship moved from
 *       the managed axis to the connected one by somebody else's action —
 *       charging them for that would make a claim quietly cost the caregiver
 *       their access.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: personId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [grants]
 *             properties:
 *               grants:
 *                 type: array
 *                 maxItems: 20
 *                 items:
 *                   type: object
 *                   required: [userId, role]
 *                   properties:
 *                     userId: { type: string, format: uuid }
 *                     role: { type: string, enum: [CAREGIVER, VIEWER] }
 *     responses:
 *       200:
 *         description: Access restored
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         personId: { type: string, format: uuid }
 *                         restored:
 *                           type: array
 *                           items: { type: string, format: uuid }
 *       400:
 *         description: Validation failed, an account this claim did not revoke was named, or this record was not claimed by this account
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: This record does not belong to the caller
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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
