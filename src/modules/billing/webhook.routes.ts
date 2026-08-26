import { Router, Request, Response, NextFunction, raw } from 'express';
import type { PaymentProvider } from '@prisma/client';

import { ok } from '@/lib/response';
import { AppError } from '@/lib/errors';
import { webhookService } from './webhook.service';

const router = Router();

const KNOWN: ReadonlyArray<PaymentProvider> = ['PAYSTACK', 'FLUTTERWAVE'];

/**
 * Provider webhooks.
 *
 * Unauthenticated by design — a provider has no session — which is exactly
 * why the signature is the only thing standing between this endpoint and
 * anyone on the internet writing to our billing state.
 *
 * `raw` rather than the global JSON parser, and mounted before it, so the
 * bytes reaching verification are the bytes the provider signed. A
 * re-serialised body will not match a signature over the original, and an
 * unsigned request is rejected before anything parses it.
 */
/**
 * @swagger
 * /billing/webhooks/{provider}:
 *   post:
 *     tags: [Billing]
 *     summary: Receive a payment provider's webhook
 *     description: |
 *       **Unauthenticated, and deliberately so — a provider has no session.**
 *       The signature over the raw body is the only thing standing between this
 *       endpoint and anyone on the internet, so it is verified before the body
 *       is parsed and before anything reaches the database. An unsigned or
 *       mis-signed request is not a malformed event, it is an unauthenticated
 *       one, and it is rejected outright.
 *
 *       The route is mounted ahead of the JSON parser and reads the body as
 *       raw bytes: a re-serialised body will not match a signature taken over
 *       the original.
 *
 *       Intake only records and acknowledges. The event is applied later, on
 *       the worker, so that a slow handler cannot turn into a duplicate
 *       delivery.
 *
 *       **Every accepted outcome is a 200**, including a duplicate. A replay is
 *       a success from the provider's point of view, and anything else invites
 *       it to retry for ever.
 *     security: []
 *     parameters:
 *       - in: path
 *         name: provider
 *         required: true
 *         schema:
 *           type: string
 *           enum: [PAYSTACK, FLUTTERWAVE]
 *         description: Case-insensitive. Anything else is a 400.
 *     requestBody:
 *       required: true
 *       description: The provider's event, verbatim. Read as raw bytes, max 1MB.
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: |
 *           Accepted, duplicate, or ignored — all three are a 200.
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
 *                         status:
 *                           type: string
 *                           enum: [accepted, duplicate, ignored]
 *       400:
 *         description: Unknown provider, or a body that could not be parsed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Missing or invalid signature
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post(
  '/:provider',
  raw({ type: '*/*', limit: '1mb' }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const provider = String(req.params.provider).toUpperCase() as PaymentProvider;

      if (!KNOWN.includes(provider)) {
        throw AppError.badRequest('Unknown payment provider');
      }

      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0]! : String(v ?? '')]),
      );

      const result = await webhookService.receive({
        provider,
        rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.from(''),
        headers,
      });

      // Both outcomes are a 200: a duplicate is a success from the provider's
      // point of view, and anything else invites it to retry forever.
      return ok(res, result, 'Webhook received');
    } catch (err) {
      next(err);
    }
  },
);

export default router;
