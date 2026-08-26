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
router.get('/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invitation = await personInvitationService.preview(String(req.params.token));
    return ok(res, invitation, 'Invitation retrieved');
  } catch (err) {
    next(err);
  }
});

/** Live invitations addressed to the signed-in account's verified address. */
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
