import axios, { AxiosInstance, AxiosError } from 'axios';

import { env } from '@/config/env';
import { createLogger } from '@/lib/logger';

const log = createLogger('paystack-api');

/**
 * The wire. Nothing here knows what a subscription means to us.
 *
 * Paystack answers `{ status, message, data }` on success *and* on most
 * failures, with the HTTP code carrying less information than the body. So the
 * envelope is unwrapped in one place and a falsy `status` is turned into a
 * thrown `PaystackError` that still carries `message` — because "This
 * subscription has already been disabled" arrives as a failure and is, for our
 * purposes, a success.
 */

export class PaystackError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'PaystackError';
  }

  /** True when the provider answered and said no; false when it never answered. */
  get answered(): boolean {
    return this.httpStatus !== null;
  }
}

interface Envelope<T> {
  status: boolean;
  message: string;
  data: T;
}

export interface PaystackApi {
  get<T>(path: string, params?: Record<string, string | number>): Promise<T>;
  post<T>(path: string, body: Record<string, unknown>): Promise<T>;
  readonly secretKey: string;
}

export const createPaystackApi = (secretKey: string): PaystackApi => {
  const http: AxiosInstance = axios.create({
    baseURL: env.PAYSTACK_BASE_URL.replace(/\/$/, ''),
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    // A payment provider that has not answered in fifteen seconds is not going
    // to. Erasure and reconciliation both call through here and neither can
    // afford to hang on it.
    timeout: 15_000,
    // We interpret the body ourselves; a 4xx is not necessarily a failure.
    validateStatus: () => true,
  });

  const unwrap = <T>(path: string, httpStatus: number, body: unknown): T => {
    const envelope = body as Partial<Envelope<T>> | null;

    if (!envelope || typeof envelope !== 'object' || envelope.status !== true) {
      const message =
        (envelope && typeof envelope.message === 'string' && envelope.message) ||
        `Paystack returned ${httpStatus} for ${path}`;
      throw new PaystackError(message, httpStatus, body);
    }

    return envelope.data as T;
  };

  const call = async <T>(
    method: 'get' | 'post',
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<T> => {
    try {
      const response =
        method === 'get'
          ? await http.get(path, { params: payload })
          : await http.post(path, payload);

      return unwrap<T>(path, response.status, response.data);
    } catch (err) {
      if (err instanceof PaystackError) throw err;

      // No answer at all: a timeout, DNS, a refused connection. Distinguished
      // from a refusal because a caller may retry one and not the other.
      const axiosErr = err as AxiosError;
      log.warn('Paystack unreachable', { path, error: axiosErr.message });
      throw new PaystackError(
        `Paystack unreachable: ${axiosErr.message}`,
        null,
        null,
      );
    }
  };

  return {
    secretKey,
    get: <T>(path: string, params?: Record<string, string | number>) =>
      call<T>('get', path, params as Record<string, unknown> | undefined),
    post: <T>(path: string, body: Record<string, unknown>) =>
      call<T>('post', path, body),
  };
};
