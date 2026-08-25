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
