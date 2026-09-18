import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import type { PrismaTx } from '@/types/prisma';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { jwtUtil } from '@/lib/jwt';
import { googleIdentityProvider, GoogleIdentity } from '@/providers/auth/google-identity.provider';
import { authRepository } from './auth.repository';
import { oauthRepository } from './oauth.repository';
import { createAccountWithSelfPerson, issueSessionForUser } from './auth.service';

const log = createLogger('google-auth');

const BCRYPT_ROUNDS = 12;

/**
 * Outcomes the callback can produce, as data rather than as a redirect string.
 * The controller decides where each one lands; keeping that decision out of
 * here means the flow is testable without an HTTP layer.
 */
export type GoogleSignInOutcome =
  | {
      status: 'AUTHENTICATED';
      created: boolean;
      profileComplete: boolean;
      user: { id: string; email: string };
      tokens: { accessToken: string; refreshToken: string };
    }
  | { status: 'EMAIL_ALREADY_REGISTERED'; email: string };

/**
 * A password nobody holds.
 *
 * `users.passwordHash` is NOT NULL and stays that way. The schema already
 * makes this argument for `email` during erasure — "making it nullable would
 * change User.email to `string | null` across the whole auth layer for no
 * gain" — and it applies identically here: a nullable hash would put a null
 * check into every password comparison in order to describe a state the login
 * path must reject anyway.
 *
 * So a federated account gets a real bcrypt hash of 32 random bytes that are
 * then discarded. `bcrypt.compare` against it returns false for every input,
 * including the empty string, and there is no value an attacker could submit
 * that matches because no value was ever chosen.
 */
const unusablePasswordHash = async (): Promise<string> =>
  bcrypt.hash(crypto.randomBytes(32).toString('hex'), BCRYPT_ROUNDS);

const resolveVerifiedIdentity = async (
  identity: GoogleIdentity,
): Promise<GoogleSignInOutcome> => {
  if (!identity.emailVerified) {
    throw AppError.badRequest(
      'Your Google email address is not verified. Verify it with Google and try again.',
    );
  }

  const existingLink = await oauthRepository.findByProviderAccount(
    'GOOGLE',
    identity.sub,
  );

  if (existingLink) {
    if (!existingLink.user.isActive) {
      throw AppError.forbidden(
        'Your account has been deactivated. Please contact support.',
      );
    }

    const tokens = await issueSessionForUser(existingLink.user);

    return {
      status: 'AUTHENTICATED',
      created: false,
      profileComplete: isProfileComplete(existingLink.user),
      user: { id: existingLink.user.id, email: existingLink.user.email },
      tokens,
    };
  }

  const existingByEmail = await authRepository.findUserByEmail(identity.email);

  if (existingByEmail) {
    return { status: 'EMAIL_ALREADY_REGISTERED', email: identity.email };
  }

  const result = await prisma.$transaction(async (tx: PrismaTx) => {
    const user = await createAccountWithSelfPerson(tx, {
      email: identity.email,
      passwordHash: await unusablePasswordHash(),
      firstName: identity.givenName,
      lastName: identity.familyName,
      emailVerified: true,
      basis: 'google-sign-in',
    });

    await oauthRepository.create(
      {
        userId: user.id,
        provider: 'GOOGLE',
        providerAccountId: identity.sub,
        email: identity.email,
      },
      tx,
    );

    const tokens = await issueSessionForUser(user, tx);
    return { user, tokens };
  });

  return {
    status: 'AUTHENTICATED',
    created: true,
    profileComplete: isProfileComplete(result.user),
    user: { id: result.user.id, email: result.user.email },
    tokens: result.tokens,
  };
};

/**
 * Whether the account has what Vitals actually requires.
 *
 * Derived, never stored. A column would be a second source of truth for
 * something the two name fields already answer, and it would drift the first
 * time someone edited a profile without updating it.
 *
 * The bar is the *existing* signup schema and nothing more: firstName and
 * lastName. Email arrives verified from Google, and password is meaningless
 * for a federated account. `gender` and `country` are optional at password
 * signup and stay optional here — asking a Google user for fields a password
 * user can skip would be inventing a requirement, not honouring one.
 *
 * Note there is no date of birth and no age check, because the password signup
 * has neither. See the note in google-auth.routes for why this flow does not
 * add one unilaterally.
 */
export const isProfileComplete = (user: {
  firstName: string | null;
  lastName: string | null;
}): boolean => Boolean(user.firstName?.trim() && user.lastName?.trim());

export const googleAuthService = {
  /**
   * Begin the round trip.
   *
   * Returns the Google URL and the nonce that must be set as an HttpOnly
   * cookie alongside it. The nonce is the CSRF defence: the signed state proves
   * we minted it, and the cookie proves it was minted for the browser that came
   * back. Without the pair, an attacker can hand someone a callback URL
   * carrying their own authorization code and sign that person into the
   * attacker's account.
   */
  start(): { url: string; nonce: string } {
    if (!googleIdentityProvider.isConfigured()) {
      throw AppError.badRequest('Google sign-in is not configured');
    }

    const nonce = crypto.randomBytes(32).toString('hex');
    const state = jwtUtil.signGoogleSignInState(nonce);

    return { url: googleIdentityProvider.generateAuthUrl(state), nonce };
  },

  /**
   * Verify the state, verify the identity, then resolve it to an account.
   *
   * Order matters. Nothing touches the database until both the state and the
   * Google identity have been verified, so an unsigned, replayed or mismatched
   * callback cannot cause a write.
   */
  async completeSignIn(params: {
    code: string;
    state: string;
    cookieNonce: string | undefined;
  }): Promise<GoogleSignInOutcome> {
    if (!googleIdentityProvider.isConfigured()) {
      throw AppError.badRequest('Google sign-in is not configured');
    }

    // ── 1. The state must be ours, for this flow, and for this browser ──
    let nonce: string;
    let type: string;

    try {
      ({ nonce, type } = jwtUtil.verifyGoogleSignInState(params.state));
    } catch {
      throw AppError.badRequest('Invalid or expired sign-in state');
    }

    // A calendar-connect state is signed with the same secret. The type
    // discriminator is what stops it being spent here.
    if (type !== 'GOOGLE_SIGN_IN') {
      throw AppError.badRequest('Invalid sign-in state');
    }

    if (!params.cookieNonce || !nonce) {
      throw AppError.badRequest('Sign-in session missing. Please try again.');
    }

    // Constant-time: the nonce is a secret for the length of the round trip.
    const provided = Buffer.from(params.cookieNonce);
    const expected = Buffer.from(nonce);

    if (
      provided.length !== expected.length ||
      !crypto.timingSafeEqual(provided, expected)
    ) {
      throw AppError.badRequest('Sign-in session did not match. Please try again.');
    }

    // ── 2. The identity must come from Google, not from the browser ──
    let identity: GoogleIdentity;

    try {
      identity = await googleIdentityProvider.verifyCode(params.code);
    } catch (err: any) {
      log.warn('Google code exchange or ID token verification failed', {
        error: err?.message,
      });
      throw AppError.badRequest('Could not verify your Google account. Please try again.');
    }

    // Google can return an unverified address on some account types. An
    // unverified address is an unproven claim to an identity, which is exactly
    // what §7 refuses to act on elsewhere in this codebase.
    if (!identity.emailVerified) {
      throw AppError.badRequest(
        'Your Google email address is not verified. Verify it with Google and try again.',
      );
    }

    // ── 3. Known identity → sign in ──
    const existingLink = await oauthRepository.findByProviderAccount(
      'GOOGLE',
      identity.sub,
    );

    if (existingLink) {
      if (!existingLink.user.isActive) {
        throw AppError.forbidden(
          'Your account has been deactivated. Please contact support.',
        );
      }

      const tokens = await issueSessionForUser(existingLink.user);

      log.info('Google sign-in', { userId: existingLink.user.id });

      return {
        status: 'AUTHENTICATED',
        created: false,
        profileComplete: isProfileComplete(existingLink.user),
        user: { id: existingLink.user.id, email: existingLink.user.email },
        tokens,
      };
    }

    // ── 4. Unknown identity on a known address → refuse, do not merge ──
    //
    // Someone holds a Vitals account at this address with a password. Google
    // has proven they control the mailbox, which is close to proof they are
    // the same person — but "close to" is the wrong standard for a health
    // record. Linking here would let anyone who ever gains control of an
    // address inherit the clinical history behind it, and the user has given
    // no indication they want the two joined.
    //
    // So the flow stops and says which door to use. The account is untouched,
    // no row is written, and nothing about it is disclosed beyond the fact the
    // caller already supplied — they typed the address into Google themselves.
    const existingByEmail = await authRepository.findUserByEmail(identity.email);

    if (existingByEmail) {
      log.info('Google sign-in refused: address already held by a password account');
      return { status: 'EMAIL_ALREADY_REGISTERED', email: identity.email };
    }

    // ── 5. New identity, new account ──
    const result = await prisma.$transaction(async (tx: PrismaTx) => {
      const user = await createAccountWithSelfPerson(tx, {
        email: identity.email,
        passwordHash: await unusablePasswordHash(),
        firstName: identity.givenName,
        lastName: identity.familyName,
        // Google verified the address. Re-verifying it ourselves would mail a
        // link asking the user to confirm something already proven.
        emailVerified: true,
        basis: 'google-sign-in',
      });

      await oauthRepository.create(
        {
          userId: user.id,
          provider: 'GOOGLE',
          providerAccountId: identity.sub,
          email: identity.email,
        },
        tx,
      );

      const tokens = await issueSessionForUser(user, tx);

      return { user, tokens };
    });

    log.info('Google account created', {
      userId: result.user.id,
      profileComplete: isProfileComplete(result.user),
    });

    return {
      status: 'AUTHENTICATED',
      created: true,
      profileComplete: isProfileComplete(result.user),
      user: { id: result.user.id, email: result.user.email },
      tokens: result.tokens,
    };
  },

  /**
   * Native clients receive an ID token directly from Google. It is verified
   * server-side against the allow-listed Android/iOS audiences before the
   * ordinary Vitals session is issued.
   */
  async completeNativeSignIn(idToken: string): Promise<GoogleSignInOutcome> {
    if (!idToken || idToken.length > 10_000) {
      throw AppError.badRequest('Invalid Google sign-in token');
    }

    let identity: GoogleIdentity;
    try {
      identity = await googleIdentityProvider.verifyNativeIdToken(idToken);
    } catch (err: any) {
      log.warn('Native Google ID token verification failed', {
        error: err?.message,
      });
      throw AppError.badRequest('Could not verify your Google account. Please try again.');
    }

    return resolveVerifiedIdentity(identity);
  },
};
