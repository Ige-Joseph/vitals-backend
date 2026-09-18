import { google } from 'googleapis';
import { env } from '@/config/env';

/**
 * Google as an *identity* provider.
 *
 * Separate from `google-calendar.provider.ts` on purpose, and the separation is
 * the security property rather than a filing decision.
 *
 * The calendar provider asks for `calendar.events` and keeps the resulting
 * access and refresh tokens, because it goes on to write to someone's diary for
 * months afterwards. This one asks for `openid email profile`, reads the
 * identity out of the response, and keeps nothing. Authentication is finished
 * the moment the identity is verified.
 *
 * Sharing one client between them would mean one `generateAuthUrl` call site
 * deciding both what the user is consenting to and which callback handles it —
 * and a mistake there grants calendar write access during a login. Two clients,
 * two scope lists, two redirect URIs, no overlap.
 */

const SIGN_IN_SCOPES = ['openid', 'email', 'profile'] as const;

/** Scopes this provider must never request. Asserted in tests. */
export const FORBIDDEN_SIGN_IN_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
] as const;

export interface GoogleIdentity {
  /** The stable subject id. This, and only this, is the identity. */
  sub: string;
  email: string;
  emailVerified: boolean;
  givenName: string | null;
  familyName: string | null;
}

const signInClient = () =>
  new google.auth.OAuth2(
    String(env.GOOGLE_CLIENT_ID),
    String(env.GOOGLE_CLIENT_SECRET),
    String(env.GOOGLE_AUTH_REDIRECT_URI),
  );

export const googleIdentityProvider = {
  /**
   * Whether sign-in is configured at all. The redirect URI is optional in env
   * so that a deployment which has not registered the second callback with
   * Google still boots — it reports the feature unavailable instead.
   */
  isConfigured(): boolean {
    return Boolean(env.GOOGLE_AUTH_REDIRECT_URI);
  },

  generateAuthUrl(state: string): string {
    return signInClient().generateAuthUrl({
      // No `access_type: 'offline'`: a refresh token is for acting on someone's
      // behalf later, and nothing here ever calls Google again. Asking for one
      // would be requesting a capability with no use for it.
      scope: [...SIGN_IN_SCOPES],
      include_granted_scopes: false,
      state,
      prompt: 'select_account',
    });
  },

  /**
   * Exchange the authorization code and verify the identity it carries.
   *
   * The identity is read from the **ID token**, verified against Google's
   * signing keys with `verifyIdToken`, not from the userinfo endpoint and never
   * from anything the browser sent us. `verifyIdToken` checks the signature,
   * the issuer, and that the audience is our own client id — the last of which
   * is what stops an ID token minted for a different application being replayed
   * here.
   *
   * Throws on anything it cannot fully verify. There is no partial success:
   * an identity we are not certain of is not an identity.
   */
  async verifyCode(code: string): Promise<GoogleIdentity> {
    const client = signInClient();

    const { tokens } = await client.getToken(code);

    if (!tokens.id_token) {
      throw new Error('Google did not return an ID token');
    }

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: String(env.GOOGLE_CLIENT_ID),
    });

    const payload = ticket.getPayload();

    if (!payload?.sub) {
      throw new Error('Google ID token carried no subject');
    }

    if (!payload.email) {
      throw new Error('Google ID token carried no email address');
    }

    return {
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified === true,
      givenName: payload.given_name ?? null,
      familyName: payload.family_name ?? null,
    };
  },
};
