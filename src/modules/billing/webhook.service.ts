import type { PaymentProvider } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { billingQueue, JOB_NAMES } from '@/queues/queue.registry';
import { providerRegistry } from './provider/provider.registry';
import type { NormalisedEvent } from './provider/payment.provider';

const log = createLogger('billing-webhook');

/**
 * Inbound provider events: the outbox pattern pointed inward.
 *
 * Persist, acknowledge, then process. A provider that does not get a prompt
 * 200 will retry, and a handler that does its work inline turns every slow
 * database write into a duplicate delivery. So intake does the minimum —
 * verify, record, enqueue — and everything else happens on the worker.
 */

export interface RawWebhook {
  provider: PaymentProvider;
  /** Untouched bytes. Signature schemes sign these, not a re-serialisation. */
  rawBody: Buffer;
  headers: Record<string, string>;
}

export const webhookService = {
  /**
   * Take an event in.
   *
   * Verification happens against the raw bytes before anything is parsed or
   * trusted: an unsigned or mis-signed request is not a malformed event, it is
   * an unauthenticated one, and it must not reach the database at all.
   */
  async receive(raw: RawWebhook): Promise<{ status: 'accepted' | 'duplicate' | 'ignored' }> {
    const adapter = providerRegistry.find(raw.provider);

    if (!adapter) {
      // Refuse rather than storing something nothing can interpret.
      throw AppError.badRequest(`No payment provider is configured for ${raw.provider}.`);
    }

    if (!adapter.verifyWebhookSignature(raw.rawBody, raw.headers)) {
      log.warn('Rejected webhook with invalid signature', { provider: raw.provider });
      throw AppError.unauthorized('Invalid webhook signature');
    }

    // Translation is the adapter's job. Intake never sees a vendor's field
    // names, and never has to guess at a shape it was not designed for.
    let event: NormalisedEvent | null;
    try {
      event = adapter.parseEvent(raw.rawBody);
    } catch (err: any) {
      throw AppError.badRequest(`Could not parse webhook: ${err?.message ?? 'unknown'}`);
    }

    if (!event) {
      // Signed, well-formed, and nothing we act on. Acknowledged so the
      // provider stops resending, and not stored, because storing every
      // uninteresting event makes the interesting ones harder to find.
      log.debug('Webhook ignored — not an event we act on', { provider: raw.provider });
      return { status: 'ignored' };
    }

    // Idempotency lives here, on the provider's event id. A replay loses the
    // insert and applies nothing — which is why the provider is free to retry
    // as often as it likes.
    const created = await prisma.billingWebhookEvent.createMany({
      data: [
        {
          provider: raw.provider,
          providerEventId: event.providerEventId,
          type: event.type,
          occurredAt: new Date(event.occurredAt),
          payload: (event.payload ?? {}) as any,
        },
      ],
      skipDuplicates: true,
    });

    if (created.count === 0) {
      log.info('Duplicate webhook ignored', {
        provider: raw.provider,
        providerEventId: event.providerEventId,
      });
      return { status: 'duplicate' };
    }

    const stored = await prisma.billingWebhookEvent.findUniqueOrThrow({
      where: {
        provider_providerEventId: {
          provider: raw.provider,
          providerEventId: event.providerEventId,
        },
      },
      select: { id: true },
    });

    // Deterministic job id, so a queue-level retry cannot double-process
    // either.
    await billingQueue.add(
      JOB_NAMES.PROCESS_BILLING_EVENT,
      { webhookEventId: stored.id },
      {
        jobId: `billing-event-${stored.id}`,
        // The same number the worker dead-letters at, so the queue giving up
        // and the row being marked exhausted are one decision, not two.
        attempts: env.BILLING_EVENT_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );

    log.info('Webhook accepted', {
      provider: raw.provider,
      providerEventId: event.providerEventId,
      type: event.type,
    });

    return { status: 'accepted' };
  },
};
