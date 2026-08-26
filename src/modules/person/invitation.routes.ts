import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';

import { authenticate } from '@/middleware/auth.middleware';
import { AuthenticatedRequest } from '@/types/express';
import { ok, validationError } from '@/lib/response';
import { personInvitationService } from './person.invitation.service';

/**
 * The invitee's side of an invitation.
 *
 * Mounted separately from `/persons` because the person answering has, in the
 * dominant case, no access to that record and no relationship to it yet —
 * everything under `/persons/:personId` goes through `assertPersonAccess`, and
 * an invitee by definition does not pass it. The token is what stands in for
 * the relationship until they accept.
 */
const router = Router();

const RESPOND_MESSAGES: Record<string, string> = {
  connected: 'Invitation accepted',
  claimed: 'Record claimed',
  refused: 'This record cannot be claimed by this account',
  declined: 'Invitation declined',
};

const respondSchema = z.object({
  /**
   * connect — take the access offered
   * claim   — "this record is about me", when the invitation offers it
   * decline — no
   */
  mode: z.enum(['connect', 'claim', 'decline']),
});

/**
 * What the link shows. Unauthenticated on purpose: the dominant case is
 * somebody with no Vitals account, and they have to be able to see what they
 * are being asked to join before creating one.
 *
 * The token is the credential — it was sent to the address — and what it
 * reveals is limited to what the email already said.
 */
/**
 * @swagger
 * /invitations/{token}:
 *   get:
 *     tags: [Invitations]
 *     summary: What an invitation link contains
 *     description: |
 *       **Unauthenticated on purpose.** The case that dominates is somebody with
 *       no Vitals account, and they have to be able to see what they are being
 *       asked to join before creating one.
 *
 *       The token is the credential — it was sent to the address — and what it
 *       reveals is no more than the email already said.
 *
 *       `claimable` is withdrawn once the record has been claimed by anybody, so
 *       the screen never offers an upgrade that acceptance would then refuse.
 *     security: []
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *         description: The raw token from the emailed link. Stored only as a SHA-256 hash.
 *     responses:
 *       200:
 *         description: The offer
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
 *                         personId:
 *                           type: string
 *                           format: uuid
 *                           description: >
 *                             Which record. Grants nothing on its own — every
 *                             person-scoped endpoint resolves access before
 *                             answering — and lets the screen after acceptance
 *                             link to the record rather than to a profile page.
 *                         email: { type: string, format: email }
 *                         role: { type: string, enum: [OWNER, CAREGIVER, VIEWER] }
 *                         claimable:
 *                           type: boolean
 *                           description: >
 *                             Whether taking ownership is on offer. When false,
 *                             clients must not explain why: whether the inviter
 *                             marked the record as being *about* the invitee is
 *                             the inviter's business.
 *                         recordName: { type: string }
 *                         inviterName: { type: string }
 *                         status:
 *                           type: string
 *                           enum: [PENDING, ACCEPTED, DECLINED, REVOKED, EXPIRED]
 *                         expiresAt: { type: string, format: date-time }
 *                         requiresSignup:
 *                           type: boolean
 *                           description: Whether signing in is enough, or an account must be created.
 *       404:
 *         description: Not a valid invitation link
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invitation = await personInvitationService.preview(String(req.params.token));
    return ok(res, invitation, 'Invitation retrieved');
  } catch (err) {
    next(err);
  }
});

/** Live invitations addressed to the signed-in account's verified address. */
/**
 * @swagger
 * /invitations:
 *   get:
 *     tags: [Invitations]
 *     summary: Live invitations addressed to the signed-in account
 *     description: |
 *       Matched on the caller's **verified** address. An account whose address
 *       is not verified gets an empty list rather than an error — it has not
 *       proven the identity these offers are addressed to.
 *
 *       Only PENDING, unexpired offers. Settled ones are history.
 *
 *       The `invitationId` returned here is not a credential: it names an offer
 *       already addressed to this account, and answering by it
 *       (`POST /invitations/by-id/{invitationId}/respond`) re-checks the
 *       address anyway.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Offers waiting for this account
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
 *                           invitationId: { type: string, format: uuid }
 *                           personId: { type: string, format: uuid }
 *                           recordName: { type: string }
 *                           role: { type: string, enum: [OWNER, CAREGIVER, VIEWER] }
 *                           claimable: { type: boolean }
 *                           inviterName: { type: string }
 *                           expiresAt: { type: string, format: date-time }
 *       401:
 *         description: Not signed in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/', authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const invitations = await personInvitationService.listPending(req.user!.sub);
    return ok(res, invitations, 'Invitations retrieved');
  } catch (err) {
    next(err);
  }
});

/**
 * Answer one.
 *
 * A refused claim is a 200, not an error. The invitation was always a
 * connection invitation and claiming is an upgrade offered on top of it, so
 * not being able to take the upgrade leaves an ordinary invitation still open
 * — the response says so, and carries what blocked the claim for the invitee's
 * eyes only.
 */
/**
 * @swagger
 * /invitations/{token}/respond:
 *   post:
 *     tags: [Invitations]
 *     summary: Answer an invitation from its emailed link
 *     description: |
 *       Requires a signed-in account whose **verified** address matches the
 *       address the invitation was sent to. The token alone is not enough: it
 *       proves the link was received, not who is holding it.
 *
 *       Three answers. `connect` takes the access offered — capacity is checked
 *       here, on the accepting account, because this is where the membership
 *       becomes ACTIVE. `claim` is "this record is about me", available only
 *       where the inviter marked it so and the caller's own record is empty.
 *       `decline` withdraws.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [mode]
 *             properties:
 *               mode:
 *                 type: string
 *                 enum: [connect, claim, decline]
 *     responses:
 *       200:
 *         description: |
 *           Answered. `outcome` says which of four things happened — and note
 *           that **`refused` is a 200, not an error**: the invitation was always
 *           a connection invitation and claiming is an upgrade offered on top of
 *           it, so not being able to take the upgrade leaves an ordinary offer,
 *           still open and still acceptable.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       oneOf:
 *                         - type: object
 *                           title: connected
 *                           properties:
 *                             outcome: { type: string, enum: [connected] }
 *                             membership: { type: object }
 *                         - type: object
 *                           title: claimed
 *                           properties:
 *                             outcome: { type: string, enum: [claimed] }
 *                             personId: { type: string, format: uuid }
 *                             supersededPersonId:
 *                               type: string
 *                               format: uuid
 *                               nullable: true
 *                               description: >
 *                                 The claimant's previous self-Person, archived
 *                                 because it was empty. Never deleted.
 *                             revoked:
 *                               type: array
 *                               description: >
 *                                 Everyone whose access the claim removed,
 *                                 returned so the next screen can offer it back
 *                                 in one step.
 *                               items:
 *                                 type: object
 *                                 properties:
 *                                   userId: { type: string, format: uuid }
 *                                   role: { type: string, enum: [OWNER, CAREGIVER, VIEWER] }
 *                                   name: { type: string }
 *                         - type: object
 *                           title: refused
 *                           properties:
 *                             outcome: { type: string, enum: [refused] }
 *                             blockedBy:
 *                               type: object
 *                               additionalProperties: { type: integer }
 *                               description: >
 *                                 What in the caller's **own** record stopped the
 *                                 claim. Returned to the invitee only — it is
 *                                 never written to the ledger and never reaches
 *                                 the inviter.
 *                             connectionStillAvailable: { type: boolean }
 *                         - type: object
 *                           title: declined
 *                           properties:
 *                             outcome: { type: string, enum: [declined] }
 *       400:
 *         description: |
 *           Validation failed, or `claim` was asked for on an invitation that
 *           does not offer ownership
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
 *         description: |
 *           The caller's email address is not verified. An unverified address is
 *           an unproven claim to an identity, and this is the one place where
 *           the identity is the whole point.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: |
 *           No pending invitation for this account. **One error covers "no such
 *           invitation", "not addressed to you" and "already answered"** —
 *           distinguishing them would let a caller probe which addresses have
 *           live invitations against which records.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: The record has since been claimed by somebody else
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post(
  '/:token/respond',
  authenticate,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = respondSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

      const result = await personInvitationService.respond(
        req.user!.sub,
        String(req.params.token),
        parsed.data.mode,
      );

      return ok(res, result, RESPOND_MESSAGES[result.outcome] ?? 'Invitation answered');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Answer one you can already see.
 *
 * The same three answers as the token route, for a caller who is signed in and
 * reading their own list of offers. The id is not a credential: the lookup is
 * narrowed by the caller's verified address, so an id addressed to somebody
 * else answers exactly as an id that does not exist.
 *
 * This exists because the token lives only in the email, and the account most
 * likely to be looking at an in-app list is the one that was *created from*
 * that email — by which point the link has usually been used or lost.
 */
/**
 * @swagger
 * /invitations/by-id/{invitationId}/respond:
 *   post:
 *     tags: [Invitations]
 *     summary: Answer an invitation listed for this account
 *     description: |
 *       The same offer as the token route, reached differently — for a caller
 *       already inside Vitals who can see the offer in `GET /invitations`. This
 *       matters most for an account created *from* an invitation, where the
 *       email has usually been used or lost.
 *
 *       **The id is not a credential.** It appears in a list that only ever
 *       returns offers addressed to the caller's own verified address, so
 *       holding one proves nothing. Authorisation is the address match, exactly
 *       as on the token route: the lookup is narrowed by the caller's verified
 *       email, so an id belonging to somebody else's offer finds nothing and
 *       answers the same 404 as an id that does not exist.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: invitationId
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
 *             required: [mode]
 *             properties:
 *               mode:
 *                 type: string
 *                 enum: [connect, claim, decline]
 *     responses:
 *       200:
 *         description: |
 *           Answered. `outcome` says which of four things happened — and note
 *           that **`refused` is a 200, not an error**: the invitation was always
 *           a connection invitation and claiming is an upgrade offered on top of
 *           it, so not being able to take the upgrade leaves an ordinary offer,
 *           still open and still acceptable.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       oneOf:
 *                         - type: object
 *                           title: connected
 *                           properties:
 *                             outcome: { type: string, enum: [connected] }
 *                             membership: { type: object }
 *                         - type: object
 *                           title: claimed
 *                           properties:
 *                             outcome: { type: string, enum: [claimed] }
 *                             personId: { type: string, format: uuid }
 *                             supersededPersonId:
 *                               type: string
 *                               format: uuid
 *                               nullable: true
 *                               description: >
 *                                 The claimant's previous self-Person, archived
 *                                 because it was empty. Never deleted.
 *                             revoked:
 *                               type: array
 *                               description: >
 *                                 Everyone whose access the claim removed,
 *                                 returned so the next screen can offer it back
 *                                 in one step.
 *                               items:
 *                                 type: object
 *                                 properties:
 *                                   userId: { type: string, format: uuid }
 *                                   role: { type: string, enum: [OWNER, CAREGIVER, VIEWER] }
 *                                   name: { type: string }
 *                         - type: object
 *                           title: refused
 *                           properties:
 *                             outcome: { type: string, enum: [refused] }
 *                             blockedBy:
 *                               type: object
 *                               additionalProperties: { type: integer }
 *                               description: >
 *                                 What in the caller's **own** record stopped the
 *                                 claim. Returned to the invitee only — it is
 *                                 never written to the ledger and never reaches
 *                                 the inviter.
 *                             connectionStillAvailable: { type: boolean }
 *                         - type: object
 *                           title: declined
 *                           properties:
 *                             outcome: { type: string, enum: [declined] }
 *       400:
 *         description: |
 *           Validation failed, or `claim` was asked for on an invitation that
 *           does not offer ownership
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
 *         description: |
 *           The caller's email address is not verified. An unverified address is
 *           an unproven claim to an identity, and this is the one place where
 *           the identity is the whole point.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: |
 *           No pending invitation for this account. **One error covers "no such
 *           invitation", "not addressed to you" and "already answered"** —
 *           distinguishing them would let a caller probe which addresses have
 *           live invitations against which records.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: The record has since been claimed by somebody else
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post(
  '/by-id/:invitationId/respond',
  authenticate,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = respondSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues[0].message);

      const result = await personInvitationService.respondById(
        req.user!.sub,
        String(req.params.invitationId),
        parsed.data.mode,
      );

      return ok(res, result, RESPOND_MESSAGES[result.outcome] ?? 'Invitation answered');
    } catch (err) {
      next(err);
    }
  },
);

export default router;
