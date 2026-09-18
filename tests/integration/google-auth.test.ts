import request from 'supertest';

/**
 * Route-level behaviour for Google Sign-In.
 *
 * The service is mocked here on purpose — its logic is covered in
 * tests/unit/google-auth.service.test.ts. What this file is about is the part
 * only the HTTP layer can get wrong: which cookies are set, where the browser
 * is sent, and whether a failure leaks why it failed.
 */

jest.mock('@/lib/prisma', () => ({
  prisma: {
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: jest.fn(),
    user: { findUnique: jest.fn(), create: jest.fn() },
    refreshToken: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    emailVerificationToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    outboxEvent: { create: jest.fn() },
  },
}));

jest.mock('@/lib/redis', () => ({
  redisConnection: { ping: jest.fn(), on: jest.fn(), disconnect: jest.fn() },
}));

jest.mock('@/modules/auth/google-auth.service', () => ({
  googleAuthService: {
    start: jest.fn(),
    completeSignIn: jest.fn(),
  },
  isProfileComplete: jest.fn(),
}));

import { createApp } from '@/app';
import { env } from '@/config/env';
import { googleAuthService } from '@/modules/auth/google-auth.service';

const app = createApp();
const mockService = googleAuthService as jest.Mocked<typeof googleAuthService>;

const NONCE = 'c'.repeat(64);

const setCookies = (res: request.Response): string[] => {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
};

beforeEach(() => {
  jest.clearAllMocks();
  mockService.start.mockReturnValue({
    url: 'https://accounts.google.com/o/oauth2/v2/auth?mock=1',
    nonce: NONCE,
  });
});

describe('GET /api/v1/auth/google', () => {
  it('returns the authorization URL', async () => {
    const res = await request(app).get('/api/v1/auth/google');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.url).toContain('accounts.google.com');
  });

  it('sets the state nonce as an HttpOnly cookie', async () => {
    const res = await request(app).get('/api/v1/auth/google');
    const stateCookie = setCookies(res).find((c) => c.startsWith('vitals_oauth_state='));

    expect(stateCookie).toBeDefined();
    expect(stateCookie).toContain('HttpOnly');
    expect(stateCookie).toContain(`Path=${env.API_PREFIX}/auth/google`);
  });

  it('never puts the nonce in the response body', async () => {
    const res = await request(app).get('/api/v1/auth/google');
    expect(JSON.stringify(res.body)).not.toContain(NONCE);
  });
});

describe('GET /api/v1/auth/google/callback', () => {
  it('redirects into the app and sets the refresh cookie on success', async () => {
    mockService.completeSignIn.mockResolvedValue({
      status: 'AUTHENTICATED',
      created: true,
      profileComplete: true,
      user: { id: 'user-1', email: 'ada@example.com' },
      tokens: { accessToken: 'access', refreshToken: 'refresh-token-value' },
    });

    const res = await request(app)
      .get('/api/v1/auth/google/callback?code=abc&state=xyz')
      .set('Cookie', [`vitals_oauth_state=${NONCE}`]);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain(`${env.FRONTEND_URL}/auth/google`);
    expect(res.headers.location).toContain('status=ok');
    expect(res.headers.location).toContain('profile=complete');

    const refresh = setCookies(res).find((c) => c.startsWith('vitals_refresh='));
    expect(refresh).toBeDefined();
    expect(refresh).toContain('HttpOnly');
  });

  it('never puts a token in the redirect URL', async () => {
    mockService.completeSignIn.mockResolvedValue({
      status: 'AUTHENTICATED',
      created: false,
      profileComplete: true,
      user: { id: 'user-1', email: 'ada@example.com' },
      tokens: { accessToken: 'access-token-value', refreshToken: 'refresh-token-value' },
    });

    const res = await request(app)
      .get('/api/v1/auth/google/callback?code=abc&state=xyz')
      .set('Cookie', [`vitals_oauth_state=${NONCE}`]);

    expect(res.headers.location).not.toContain('access-token-value');
    expect(res.headers.location).not.toContain('refresh-token-value');
  });

  it('routes an incomplete profile to onboarding', async () => {
    mockService.completeSignIn.mockResolvedValue({
      status: 'AUTHENTICATED',
      created: true,
      profileComplete: false,
      user: { id: 'user-2', email: 'no-name@example.com' },
      tokens: { accessToken: 'access', refreshToken: 'refresh' },
    });

    const res = await request(app)
      .get('/api/v1/auth/google/callback?code=abc&state=xyz')
      .set('Cookie', [`vitals_oauth_state=${NONCE}`]);

    expect(res.headers.location).toContain('profile=incomplete');
  });

  it('reports the password-account collision without issuing a session', async () => {
    mockService.completeSignIn.mockResolvedValue({
      status: 'EMAIL_ALREADY_REGISTERED',
      email: 'ada@example.com',
    });

    const res = await request(app)
      .get('/api/v1/auth/google/callback?code=abc&state=xyz')
      .set('Cookie', [`vitals_oauth_state=${NONCE}`]);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('status=email_exists');
    expect(setCookies(res).find((c) => c.startsWith('vitals_refresh='))).toBeUndefined();
  });

  it('clears the state cookie whatever the outcome', async () => {
    mockService.completeSignIn.mockRejectedValue(new Error('anything'));

    const res = await request(app)
      .get('/api/v1/auth/google/callback?code=abc&state=xyz')
      .set('Cookie', [`vitals_oauth_state=${NONCE}`]);

    const cleared = setCookies(res).find((c) => c.startsWith('vitals_oauth_state='));
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
  });

  it('does not disclose why a sign-in failed', async () => {
    mockService.completeSignIn.mockRejectedValue(
      new Error('Sign-in session did not match. Please try again.'),
    );

    const res = await request(app)
      .get('/api/v1/auth/google/callback?code=abc&state=xyz')
      .set('Cookie', [`vitals_oauth_state=${NONCE}`]);

    expect(res.headers.location).toContain('reason=sign_in_failed');
    expect(res.headers.location).not.toContain('did+not+match');
    expect(res.headers.location).not.toContain('session');
  });

  it('treats a declined consent as a cancellation, not an error', async () => {
    const res = await request(app).get(
      '/api/v1/auth/google/callback?error=access_denied',
    );

    expect(res.headers.location).toContain('status=cancelled');
    expect(mockService.completeSignIn).not.toHaveBeenCalled();
  });

  it('rejects a callback missing code or state before calling the service', async () => {
    const res = await request(app).get('/api/v1/auth/google/callback?code=abc');

    expect(res.headers.location).toContain('reason=missing_parameters');
    expect(mockService.completeSignIn).not.toHaveBeenCalled();
  });
});

describe('existing auth behaviour is unchanged', () => {
  it('still validates password signup', async () => {
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ password: 'Password1' });

    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('does not shadow /auth/me with the google router', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    // 401 rather than 404: the route still exists and still requires auth.
    expect(res.status).toBe(401);
  });
});
