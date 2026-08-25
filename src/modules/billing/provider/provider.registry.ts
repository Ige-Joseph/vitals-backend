import type { PaymentProvider } from '@prisma/client';

import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import type { PaymentProviderAdapter, CancelResult } from './payment.provider';

const log = createLogger('provider-registry');

/**
 * Which adapters exist.
 *
 * Empty, deliberately. No provider is integrated, and this file refuses rather
 * than pretending: a caller that needs one gets a clear error instead of a
 * silent no-op that looks like success and leaves a subscription live at a
 * provider nobody is talking to.
 *
 * Registering an adapter is the whole of "adding a provider" from the rest of
 * the codebase's point of view.
 */
const adapters = new Map<PaymentProvider, PaymentProviderAdapter>();

export const providerRegistry = {
  register(adapter: PaymentProviderAdapter): void {
    adapters.set(adapter.name, adapter);
    log.info('Payment provider registered', { provider: adapter.name });
  },

  /** The adapter, or undefined. Callers that can cope with absence use this. */
  find(provider: PaymentProvider): PaymentProviderAdapter | undefined {
    return adapters.get(provider);
  },

  /** The adapter, or a refusal. Callers that cannot cope use this. */
  require(provider: PaymentProvider): PaymentProviderAdapter {
    const adapter = adapters.get(provider);
    if (!adapter) {
      throw AppError.badRequest(
        `No payment provider is configured for ${provider}.`,
      );
    }
    return adapter;
  },

  get isConfigured(): boolean {
    return adapters.size > 0;
  },

  /**
   * Best-effort cancellation.
   *
   * Used by erasure and deactivation, where a provider outage must never block
   * the operation: a data subject's right to erasure does not depend on a
   * third party being reachable. The caller records the outcome and leaves
   * reconciliation to retry an unconfirmed cancellation.
   */
  async tryCancel(
    provider: PaymentProvider,
    providerSubscriptionId: string | null,
    reason: string,
  ): Promise<CancelResult> {
    if (!providerSubscriptionId) {
      // Nothing was ever created provider-side — checkout never completed.
      return { confirmed: true, detail: 'no provider subscription' };
    }

    const adapter = adapters.get(provider);
    if (!adapter) {
      log.warn('Cancellation requested with no adapter registered', {
        provider,
        providerSubscriptionId,
      });
      return { confirmed: false, detail: `no adapter for ${provider}` };
    }

    try {
      return await adapter.cancelSubscription({
        providerSubscriptionId,
        immediate: true,
        reason,
      });
    } catch (err: any) {
      log.error('Provider cancellation failed', {
        provider,
        providerSubscriptionId,
        error: err?.message,
      });
      return { confirmed: false, detail: err?.message ?? 'provider error' };
    }
  },
};
