import { env } from '@/config/env';
import { createLogger } from '@/lib/logger';
import { providerRegistry } from '../provider.registry';
import { createPaystackAdapter } from './paystack.adapter';

const log = createLogger('paystack');

export { createPaystackAdapter } from './paystack.adapter';
export { parsePaystackEvent } from './paystack.events';

/**
 * Register Paystack, if there is a key to register it with.
 *
 * Absence is a valid configuration, not a failure: a developer's machine, CI
 * and the test harness all run without one, and everything downstream already
 * copes — the registry answers "not configured", reconciliation skips itself,
 * and a checkout attempt refuses with a clear message rather than pretending.
 *
 * A live key in a non-production environment is refused outright. It is an
 * easy mistake to make — one paste into the wrong `.env` — and the failure
 * mode is charging real cards from a development box. Nothing about this
 * codebase would notice; this line does.
 */
export const registerPaystack = (): boolean => {
  const key = env.PAYSTACK_SECRET_KEY;

  if (!key) {
    log.info('Paystack not configured — no secret key present');
    return false;
  }

  const isLiveKey = key.startsWith('sk_live_');

  if (isLiveKey && env.NODE_ENV !== 'production') {
    log.error('Refusing to register a live Paystack key outside production', {
      nodeEnv: env.NODE_ENV,
    });
    throw new Error(
      'PAYSTACK_SECRET_KEY is a live key but NODE_ENV is not production. ' +
        'Use a test key (sk_test_…) outside production.',
    );
  }

  providerRegistry.register(createPaystackAdapter(key));
  log.info('Paystack registered', { mode: isLiveKey ? 'live' : 'test' });
  return true;
};
