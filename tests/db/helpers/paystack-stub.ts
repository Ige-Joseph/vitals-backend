import http from 'http';
import type { AddressInfo } from 'net';

import { PLAN_CODE, CUSTOMER_CODE } from './paystack-fixtures';

/**
 * A stand-in for Paystack's API, on localhost.
 *
 * The alternative — mocking axios — would test the adapter against our own
 * idea of the adapter. This way the real client runs: the real envelope
 * unwrapping, the real `status: false` handling, the real timeout config. What
 * it does not do is reach the internet, which is the other requirement.
 *
 * It answers in Paystack's envelope, including for failures, because that
 * envelope is the thing the client exists to cope with.
 */

export interface PaystackStub {
  baseUrl: string;
  /** Every call made, in order, for asserting on what the adapter actually sent. */
  calls: Array<{ method: string; path: string; body: any }>;
  /** Override any route for one test: return `[httpStatus, envelope]`. */
  route(key: string, handler: (body: any) => [number, unknown]): void;
  close(): Promise<void>;
}

const ok = (data: unknown): [number, unknown] => [200, { status: true, message: 'ok', data }];
const no = (message: string, code = 400): [number, unknown] => [
  code,
  { status: false, message, data: null },
];

export const startPaystackStub = async (): Promise<PaystackStub> => {
  const calls: PaystackStub['calls'] = [];
  const overrides = new Map<string, (body: any) => [number, unknown]>();

  const defaults: Record<string, (body: any) => [number, unknown]> = {
    'POST /customer': (body) =>
      // The same codes the webhook fixtures carry, so a plan created here and
      // a subscription announced there describe one subscriber.
      ok({ customer_code: CUSTOMER_CODE, email: body.email, id: 1 }),

    // No plans exist yet, so ensurePlan has to create one.
    'GET /plan': () => ok([]),

    'POST /plan': (body) =>
      ok({
        plan_code: PLAN_CODE,
        name: body.name,
        description: body.description,
        amount: body.amount,
        interval: body.interval,
        currency: body.currency,
      }),

    'POST /transaction/initialize': (body) =>
      ok({
        authorization_url: `https://checkout.paystack.test/${body.reference}`,
        access_code: 'ac_stubbed',
        reference: body.reference,
      }),

    'POST /subscription/disable': () => ok({ disabled: true }),
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url ?? '/', 'http://stub');
      const path = url.pathname;

      calls.push({ method: req.method ?? 'GET', path, body });

      // Exact route first, then a prefix match so `/subscription/:code` works.
      const exact = `${req.method} ${path}`;
      const prefix = `${req.method} ${path.split('/').slice(0, 2).join('/')}/:id`;

      const handler =
        overrides.get(exact) ??
        overrides.get(prefix) ??
        defaults[exact] ??
        defaults[prefix];

      const [status, payload] = handler
        ? handler(body)
        : no(`stub has no route for ${exact}`, 404);

      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    route: (key, handler) => overrides.set(key, handler),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

export const envelope = { ok, no };
