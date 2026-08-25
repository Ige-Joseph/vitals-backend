import type { PaymentProvider } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { billingQueue, JOB_NAMES } from '@/queues/queue.registry';
import { providerRegistry } from './provider/provider.registry';

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

/** What every adapter must produce from a raw event. */
export interface NormalisedEvent {
  providerEventId: string;
  type: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

export const webhookService = {
  /**
   * Take an event in.
   *
   * Verification happens against the raw bytes before anything is parsed or
   * trusted: an unsigned or mis-signed request is not a malformed event, it is
   * an unauthenticated one, and it must not reach the database at all.
   */
  async receive(raw: RawWebhook): Promise<{ status: 'accepted' | 'duplicate' }> {
    const adapter = providerRegistry.find(raw.provider);

    if (!adapter) {
      // Refuse rather than storing something nothing can interpret.
      throw AppError.badRequest(`No payment provider is configured for ${raw.provider}.`);
    }

    if (!adapter.verifyWebhookSignature(raw.rawBody, raw.headers)) {
      log.warn('Rejected webhook with invalid signature', { provider: raw.provider });
      throw AppError.unauthorized('Invalid webhook signature');
    }

    let event: NormalisedEvent;
    try {
      event = JSON.parse(raw.rawBody.toString('utf8')) as NormalisedEvent;
    } catch {
      throw AppError.badRequest('Webhook body is not valid JSON');
    }

    if (!event.providerEventId || !event.type || !event.occurredAt) {
      throw AppError.badRequest('Webhook is missing providerEventId, type or occurredAt');
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
      { jobId: `billing-event-${stored.id}`, attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
    );

    log.info('Webhook accepted', {
      provider: raw.provider,
      providerEventId: event.providerEventId,
      type: event.type,
    });

    return { status: 'accepted' };
  },
};
