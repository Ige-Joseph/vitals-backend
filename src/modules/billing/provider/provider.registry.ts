import type { PaymentProvider } from '@prisma/client';

import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import type { PaymentProviderAdapter, CancelResult } from './payment.provider';

const log = createLogger('provider-registry');

/**
 * Which adapters exist.
 *
 * Populated at start-up, and only for providers that are actually configured.
 * An unconfigured provider is refused rather than pretended at: a caller gets
 * a clear error instead of a silent no-op that looks like success and leaves a
 * subscription live at a provider nobody is talking to.
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

  /**
   * Forget every adapter.
   *
   * A test seam, and only that. Nothing in the running application unregisters
   * a provider — an adapter is registered once at start-up and lives as long
   * as the process.
   *
   * It exists because this map is module state, and the database harness
   * truncates tables rather than reloading modules: an adapter registered by
   * one test would otherwise still be there for the next one, pointing at a
   * stub server that has since been closed. That leaks in the direction that
   * hides bugs — `isConfigured` reads true when the test doing the reading
   * configured nothing.
   */
  reset(): void {
    adapters.clear();
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
   * The adapter a new purchase should go through.
   *
   * One provider is registered, so "the default" is "the one there is". Kept
   * as a function rather than a constant because the day a second one is added
   * this becomes a routing decision — by currency, by country, by whichever is
   * up — and the call sites should already be asking rather than naming a
   * vendor.
   */
  requireDefault(): PaymentProviderAdapter {
    const [adapter] = adapters.values();
    if (!adapter) {
      throw AppError.badRequest(
        'No payment provider is configured, so a subscription cannot be bought right now.',
      );
    }
    return adapter;
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
    subscription: {
      provider: PaymentProvider;
      providerSubscriptionId: string | null;
      /** Passed through untouched; only the adapter knows what is in it. */
      providerMetadata?: unknown;
    },
    reason: string,
  ): Promise<CancelResult> {
    const { provider, providerSubscriptionId } = subscription;

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
        providerMetadata:
          (subscription.providerMetadata as Record<string, unknown> | undefined) ?? undefined,
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
