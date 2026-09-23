import { jwtUtil } from '@/lib/jwt';

/**
 * Google Sign-In.
 *
 * Prisma is mocked, but `createAccountWithSelfPerson` is not: the transaction
 * callback runs for real against the mock client, so the assertions about the
 * self-Person are about the code that actually creates it rather than about a
 * stub standing in for it. A mocked-out person.create would pass whether or not
 * `origin: SELF` were ever written.
 */

jest.mock('@/lib/prisma', () => {
  const model = () => ({
    create: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  });

  const client: any = {
    user: model(),
    person: model(),
    personMembership: model(),
    personAccessEvent: model(),
    profile: model(),
    oAuthAccount: model(),
    refreshToken: model(),
    emailVerificationToken: model(),
    outboxEvent: model(),
  };

  client.$transaction = jest.fn(async (fn: any) => fn(client));

  return { prisma: client };
});

jest.mock('@/providers/auth/google-identity.provider', () => ({
  googleIdentityProvider: {
    isConfigured: jest.fn(() => true),
    generateAuthUrl: jest.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?mock=1'),
    verifyCode: jest.fn(),
  },
  FORBIDDEN_SIGN_IN_SCOPES: ['https://www.googleapis.com/auth/calendar.events'],
}));

jest.mock('@/providers/email/email.service', () => ({
  emailService: { send: jest.fn(), sendVerificationEmail: jest.fn() },
}));

jest.mock('@/lib/redis', () => ({
  redisConnection: { ping: jest.fn(), on: jest.fn(), disconnect: jest.fn() },
}));

import { prisma } from '@/lib/prisma';
import { googleIdentityProvider } from '@/providers/auth/google-identity.provider';
import { googleAuthService, isProfileComplete } from '@/modules/auth/google-auth.service';

const mockPrisma = prisma as any;
const mockProvider = googleIdentityProvider as jest.Mocked<typeof googleIdentityProvider>;

const IDENTITY = {
  sub: '110000000000000000001',
  email: 'ada@example.com',
  emailVerified: true,
  givenName: 'Ada',
  familyName: 'Okafor',
};

const USER = {
  id: 'user-1',
  email: 'ada@example.com',
  firstName: 'Ada',
  lastName: 'Okafor',
  role: 'USER',
  planType: 'FREE',
  emailVerified: true,
  isActive: true,
};

/** A state/cookie pair that will actually verify. */
const validState = () => {
  const nonce = 'a'.repeat(64);
  return { state: jwtUtil.signGoogleSignInState(nonce), cookieNonce: nonce };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockProvider.isConfigured.mockReturnValue(true);
  mockProvider.verifyCode.mockResolvedValue(IDENTITY);

  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
  mockPrisma.oAuthAccount.findUnique.mockResolvedValue(null);
  mockPrisma.user.findUnique.mockResolvedValue(null);
  mockPrisma.user.create.mockResolvedValue(USER);
  mockPrisma.person.create.mockResolvedValue({ id: 'person-1' });
  mockPrisma.personMembership.create.mockResolvedValue({});
  mockPrisma.personAccessEvent.create.mockResolvedValue({});
  mockPrisma.oAuthAccount.create.mockResolvedValue({});
  mockPrisma.refreshToken.create.mockResolvedValue({});
});

describe('Google sign-in — new user', () => {
  it('authenticates and reports the account as created', async () => {
    const outcome = await googleAuthService.completeSignIn({
      code: 'good-code',
      ...validState(),
    });

    expect(outcome.status).toBe('AUTHENTICATED');
    if (outcome.status !== 'AUTHENTICATED') return;

    expect(outcome.created).toBe(true);
    expect(outcome.tokens.accessToken).toEqual(expect.any(String));
    expect(outcome.tokens.refreshToken).toEqual(expect.any(String));
  });

  it('creates the User with the address Google verified', async () => {
    await googleAuthService.completeSignIn({ code: 'good-code', ...validState() });

    expect(mockPrisma.user.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: 'ada@example.com',
        emailVerified: true,
      }),
    });
  });

  it('never stores a usable password for a federated account', async () => {
    await googleAuthService.completeSignIn({ code: 'good-code', ...validState() });

    const { passwordHash } = mockPrisma.user.create.mock.calls[0][0].data;

    // A real bcrypt hash of bytes that were discarded — not an empty string,
    // not a placeholder, and not something a caller could submit.
    expect(passwordHash).toMatch(/^\$2[aby]\$/);
    expect(passwordHash.length).toBeGreaterThan(50);
  });

  it("creates the user's self-Person with origin SELF", async () => {
    await googleAuthService.completeSignIn({ code: 'good-code', ...validState() });

    expect(mockPrisma.person.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.person.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        origin: 'SELF',
        ownerUserId: USER.id,
        createdByUserId: USER.id,
        displayName: 'Ada Okafor',
      }),
    });
  });

  it('grants the account OWNER membership on its own Person', async () => {
    await googleAuthService.completeSignIn({ code: 'good-code', ...validState() });

    expect(mockPrisma.personMembership.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        personId: 'person-1',
        userId: USER.id,
        role: 'OWNER',
        status: 'ACTIVE',
      }),
    });
  });

  it('records the claim in the access ledger with a federated basis', async () => {
    await googleAuthService.completeSignIn({ code: 'good-code', ...validState() });

    expect(mockPrisma.personAccessEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'CLAIMED',
        role: 'OWNER',
        basis: 'google-sign-in',
      }),
    });
  });

  it('links the identity by Google sub, not by email', async () => {
    await googleAuthService.completeSignIn({ code: 'good-code', ...validState() });

    expect(mockPrisma.oAuthAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: 'GOOGLE',
        providerAccountId: IDENTITY.sub,
        userId: USER.id,
      }),
    });
  });

  it('sends a user Google gave no name to profile completion', async () => {
    mockProvider.verifyCode.mockResolvedValue({
      ...IDENTITY,
      givenName: null,
      familyName: null,
    });
    mockPrisma.user.create.mockResolvedValue({
      ...USER,
      firstName: null,
      lastName: null,
    });

    const outcome = await googleAuthService.completeSignIn({
      code: 'good-code',
      ...validState(),
    });

    expect(outcome.status).toBe('AUTHENTICATED');
    if (outcome.status !== 'AUTHENTICATED') return;
    expect(outcome.profileComplete).toBe(false);
  });

  it('does not ask for a profile the provider already supplied', async () => {
    const outcome = await googleAuthService.completeSignIn({
      code: 'good-code',
      ...validState(),
    });

    expect(outcome.status).toBe('AUTHENTICATED');
    if (outcome.status !== 'AUTHENTICATED') return;
    expect(outcome.profileComplete).toBe(true);
  });
});

describe('Google sign-in — returning user', () => {
  it('signs in the linked account without creating anything', async () => {
    mockPrisma.oAuthAccount.findUnique.mockResolvedValue({
      id: 'oauth-1',
      userId: USER.id,
      provider: 'GOOGLE',
      providerAccountId: IDENTITY.sub,
      user: USER,
    });

    const outcome = await googleAuthService.completeSignIn({
      code: 'good-code',
      ...validState(),
    });

    expect(outcome.status).toBe('AUTHENTICATED');
    if (outcome.status !== 'AUTHENTICATED') return;

    expect(outcome.created).toBe(false);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockPrisma.person.create).not.toHaveBeenCalled();
  });

  it('resolves on sub even when the Google address has changed', async () => {
    mockProvider.verifyCode.mockResolvedValue({
      ...IDENTITY,
      email: 'ada.okafor@newdomain.com',
    });
    mockPrisma.oAuthAccount.findUnique.mockResolvedValue({
      userId: USER.id,
      provider: 'GOOGLE',
      providerAccountId: IDENTITY.sub,
      user: USER,
    });

    const outcome = await googleAuthService.completeSignIn({
      code: 'good-code',
      ...validState(),
    });

    expect(mockPrisma.oAuthAccount.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          provider_providerAccountId: {
            provider: 'GOOGLE',
            providerAccountId: IDENTITY.sub,
          },
        },
      }),
    );
    expect(outcome.status).toBe('AUTHENTICATED');
    if (outcome.status !== 'AUTHENTICATED') return;
    expect(outcome.user.id).toBe(USER.id);
  });

  it('refuses a deactivated account', async () => {
    mockPrisma.oAuthAccount.findUnique.mockResolvedValue({
      userId: USER.id,
      user: { ...USER, isActive: false },
    });

    await expect(
      googleAuthService.completeSignIn({ code: 'good-code', ...validState() }),
    ).rejects.toThrow(/deactivated/i);
  });
});

describe('Google sign-in — collision with a password account', () => {
  it('refuses rather than silently creating a second account', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ ...USER, id: 'existing-user' });

    const outcome = await googleAuthService.completeSignIn({
      code: 'good-code',
      ...validState(),
    });

    expect(outcome.status).toBe('EMAIL_ALREADY_REGISTERED');
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockPrisma.oAuthAccount.create).not.toHaveBeenCalled();
    expect(mockPrisma.person.create).not.toHaveBeenCalled();
  });

  it('does not link the identity to the existing account', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ ...USER, id: 'existing-user' });

    await googleAuthService.completeSignIn({ code: 'good-code', ...validState() });

    expect(mockPrisma.oAuthAccount.create).not.toHaveBeenCalled();
  });
});

describe('Google sign-in — state and code rejection', () => {
  it('rejects a state token we did not sign', async () => {
    await expect(
      googleAuthService.completeSignIn({
        code: 'good-code',
        state: 'not.a.jwt',
        cookieNonce: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/state/i);

    expect(mockProvider.verifyCode).not.toHaveBeenCalled();
  });

  it('rejects a calendar-connect state replayed at the sign-in callback', async () => {
    // Signed with the same secret, so only the type discriminator separates it.
    const calendarState = jwtUtil.generateOAuthStateToken('user-1');

    await expect(
      googleAuthService.completeSignIn({
        code: 'good-code',
        state: calendarState,
        cookieNonce: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/state/i);

    expect(mockProvider.verifyCode).not.toHaveBeenCalled();
  });

  it('rejects a state whose nonce does not match the cookie', async () => {
    const { state } = validState();

    await expect(
      googleAuthService.completeSignIn({
        code: 'good-code',
        state,
        cookieNonce: 'b'.repeat(64),
      }),
    ).rejects.toThrow(/did not match/i);

    expect(mockProvider.verifyCode).not.toHaveBeenCalled();
  });

  it('rejects a callback arriving with no state cookie at all', async () => {
    const { state } = validState();

    await expect(
      googleAuthService.completeSignIn({ code: 'good-code', state, cookieNonce: undefined }),
    ).rejects.toThrow(/session missing/i);
  });

  it('rejects an invalid or expired authorization code', async () => {
    mockProvider.verifyCode.mockRejectedValue(new Error('invalid_grant'));

    await expect(
      googleAuthService.completeSignIn({ code: 'stale-code', ...validState() }),
    ).rejects.toThrow(/could not verify your google account/i);

    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it('refuses an identity whose email Google has not verified', async () => {
    mockProvider.verifyCode.mockResolvedValue({ ...IDENTITY, emailVerified: false });

    await expect(
      googleAuthService.completeSignIn({ code: 'good-code', ...validState() }),
    ).rejects.toThrow(/not verified/i);

    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it('writes nothing when the state is bad', async () => {
    await expect(
      googleAuthService.completeSignIn({
        code: 'good-code',
        state: 'not.a.jwt',
        cookieNonce: 'a'.repeat(64),
      }),
    ).rejects.toThrow();

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockPrisma.person.create).not.toHaveBeenCalled();
  });
});

describe('isProfileComplete', () => {
  it.each([
    [{ firstName: 'Ada', lastName: 'Okafor' }, true],
    [{ firstName: 'Ada', lastName: null }, false],
    [{ firstName: null, lastName: 'Okafor' }, false],
    [{ firstName: null, lastName: null }, false],
    [{ firstName: '  ', lastName: 'Okafor' }, false],
  ])('%j → %s', (user, expected) => {
    expect(isProfileComplete(user as any)).toBe(expected);
  });
});
